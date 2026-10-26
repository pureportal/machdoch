import Link from "next/link";
import { Command } from "lucide-react";

export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="cloud-auth">
      <Link className="cloud-auth-brand" href="/cloud">
        <span className="cloud-brand-mark">
          <Command size={20} />
        </span>
        <span>
          machdoch<span className="cloud-brand-suffix">.cloud</span>
        </span>
      </Link>
      <section className="cloud-auth-panel">{children}</section>
    </main>
  );
}
