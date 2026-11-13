import Link from "next/link";
import type { NavigationSection } from "./navigation";

export function SectionNavigation({ section }: { section: NavigationSection }) {
  return (
    <nav aria-label={section.label} className="cloud-section-navigation">
      {section.pages.map((page) => (
        <Link
          key={page.href}
          href={page.href}
          aria-current={page === section.page ? "page" : undefined}
        >
          {page.label}
        </Link>
      ))}
    </nav>
  );
}
