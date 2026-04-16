import type { JSX } from "react";
import { ChatSession } from "../chat-session";

export const App = (): JSX.Element => {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 flex flex-col">
      <ChatSession />
    </main>
  );
};
