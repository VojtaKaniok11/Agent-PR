import * as dotenv from "dotenv";
dotenv.config();
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { ImapFlow } from "imapflow";

// Definice stavu agenta
const AgentState = Annotation.Root({
  foundEmails: Annotation<any[]>({ reducer: (x, y) => y, default: () => [] }),
  isPayroll: Annotation<boolean>({ reducer: (x, y) => y, default: () => false }),
});

// 1. KROK: Stažení posledních 10 emailů včetně informace, zda jsou přečtené
async function fetchLatestEmails() {
  console.log("🔍 Kontroluji poštu (posledních 10 zpráv)...");
  const client = new ImapFlow({
    host: "imap.seznam.cz",
    port: 993,
    secure: true,
    auth: { user: process.env.SEZNAM_EMAIL!, pass: process.env.SEZNAM_PASSWORD! },
    logger: false
  });

  await client.connect();
  let lock = await client.getMailboxLock("INBOX");
  const emails = [];

  try {
    const status = await client.status('INBOX', { messages: true });
    const total = status.messages;
    // Vezmeme rozsah posledních 10 zpráv
    const range = `${Math.max(1, total - 9)}:${total}`;

    // DŮLEŽITÉ: Přidali jsme flags: true, abychom věděli, zda je mail přečtený
    for await (let msg of client.fetch(range, { envelope: true, flags: true })) {
      emails.push({ 
        subject: msg.envelope?.subject || "", 
        from: msg.envelope?.from?.[0]?.address || "",
        // Pokud flagy NEobsahují \Seen, mail je NEPŘEČTENÝ
        isUnread: !msg.flags.has("\\Seen")
      });
    }
  } finally { 
    lock.release(); 
  }

  await client.logout();
  // Otočíme pořadí, aby nejnovější byly první
  return { foundEmails: emails.reverse() };
}

// 2. KROK: Filtrace nepřečtených a analýza pomocí AI
async function analyzeWithFilterAndAI(state: typeof AgentState.State) {
  // FILTR: Necháme si jen ty, které jsou nepřečtené
  const unreadEmails = state.foundEmails.filter(e => e.isUnread);

  if (unreadEmails.length === 0) {
    console.log("ℹ️ Žádné nové (nepřečtené) e-maily k analýze.");
    return { isPayroll: false };
  }

  const subjects = unreadEmails.map(e => e.subject.toLowerCase()).join(" ");
  const keywords = ["výplat", "mzda", "páska", "vyúčtování"];

  // Rychlá kontrola na klíčová slova v nepřečtených mailech
  if (!keywords.some(kw => subjects.includes(kw))) {
    console.log(`ℹ️ Prohledáno ${unreadEmails.length} nepřečtených zpráv, ale žádná nevypadá jako výplatnice.`);
    return { isPayroll: false };
  }

  console.log("🤖 Našel jsem nepřečtený e-mail, který by mohl být výplatnicí. Ptám se AI...");
  
  const llm = new ChatOpenAI({ modelName: "gpt-4o-mini", temperature: 0 });
  const fullText = unreadEmails.map(e => `Od: ${e.from}, Předmět: ${e.subject}`).join("\n");
  
  const response = await llm.invoke(`Je v tomto seznamu výplatní páska? Odpověz ANO nebo NE:\n\n${fullText}`);
  const answer = response.content.toString().toUpperCase().includes("ANO");

  if (answer) {
    console.log("✅ AI potvrdila výplatnici!");
  } else {
    console.log("❌ AI říká, že to výplatnice není.");
  }

  return { isPayroll: answer };
}

// 3. KROK: Notifikace na Discord
async function notifyDiscord(state: typeof AgentState.State) {
  if (state.isPayroll) {
    await fetch(process.env.DISCORD_WEBHOOK_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "🔔 **Výplatnice dorazila a je nepřečtená!** 💰" }),
    });
    console.log("🚀 Discord notifikace odeslána.");
  }
}

// Sestavení grafu (workflow)
const workflow = new StateGraph(AgentState)
  .addNode("fetch", fetchLatestEmails)
  .addNode("analyze", analyzeWithFilterAndAI)
  .addNode("notify", notifyDiscord)
  .addEdge(START, "fetch")
  .addEdge("fetch", "analyze")
  .addEdge("analyze", "notify")
  .addEdge("notify", END);

const app = workflow.compile();

// Spuštění
app.invoke({}).then(() => {
    console.log("🏁 Kontrola hotova. Program se ukončuje.");
    process.exit(0);
});