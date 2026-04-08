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

// 1. KROK: Stažení posledních 10 emailů
async function fetchLatestEmails() {
  console.log("🔍 Kontroluji poštu (posledních 10 zpráv)...");
  const client = new ImapFlow({
    host: "imap.seznam.cz",
    port: 993,
    secure: true,
    auth: { 
      user: process.env.EMAIL_USER!, // Změněno
      pass: process.env.EMAIL_PASS!  // Změněno
    },
    logger: false
  });

  await client.connect();
  let lock = await client.getMailboxLock("INBOX");
  const emails = [];

  try {
    const status = await client.status('INBOX', { messages: true });
    const total = status.messages;
    const range = `${Math.max(1, total - 9)}:${total}`;

    for await (let msg of client.fetch(range, { envelope: true, flags: true })) {
      emails.push({ 
        subject: msg.envelope?.subject || "", 
        from: msg.envelope?.from?.[0]?.address || "",
        isUnread: !msg.flags.has("\\Seen")
      });
    }
  } finally { 
    lock.release(); 
  }

  await client.logout();
  return { foundEmails: emails.reverse() };
}

// 2. KROK: Filtrace a AI analýza
async function analyzeWithFilterAndAI(state: typeof AgentState.State) {
  const unreadEmails = state.foundEmails.filter(e => e.isUnread);

  if (unreadEmails.length === 0) {
    console.log("ℹ️ Žádné nové (nepřečtené) e-maily k analýze.");
    return { isPayroll: false };
  }

  const subjects = unreadEmails.map(e => e.subject.toLowerCase()).join(" ");
  const keywords = ["výplat", "mzda", "páska", "vyúčtování"];

  if (!keywords.some(kw => subjects.includes(kw))) {
    console.log(`ℹ️ Prohledáno ${unreadEmails.length} nepřečtených zpráv, ale žádná nevypadá jako výplatnice.`);
    return { isPayroll: false };
  }

  console.log("🤖 Našel jsem nepřečtený e-mail. Ptám se AI...");
  
  // ChatOpenAI si automaticky vezme OPENAI_API_KEY z environmentu (YAML)
  const llm = new ChatOpenAI({ modelName: "gpt-4o-mini", temperature: 0 });
  const fullText = unreadEmails.map(e => `Od: ${e.from}, Předmět: ${e.subject}`).join("\n");
  
  const response = await llm.invoke(`Je v tomto seznamu výplatní páska? Odpověz ANO nebo NE:\n\n${fullText}`);
  const answer = response.content.toString().toUpperCase().includes("ANO");

  return { isPayroll: answer };
}

// 3. KROK: Notifikace na Discord
async function notifyDiscord(state: typeof AgentState.State) {
  if (state.isPayroll) {
    await fetch(process.env.DISCORD_WEBHOOK!, { // Změněno
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "🔔 **Výplatnice dorazila a je nepřečtená!** 💰" }),
    });
    console.log("🚀 Discord notifikace odeslána.");
  }
}

const workflow = new StateGraph(AgentState)
  .addNode("fetch", fetchLatestEmails)
  .addNode("analyze", analyzeWithFilterAndAI)
  .addNode("notify", notifyDiscord)
  .addEdge(START, "fetch")
  .addEdge("fetch", "analyze")
  .addEdge("analyze", "notify")
  .addEdge("notify", END);

const app = workflow.compile();

app.invoke({}).then(() => {
    console.log("🏁 Kontrola hotova.");
    process.exit(0);
});