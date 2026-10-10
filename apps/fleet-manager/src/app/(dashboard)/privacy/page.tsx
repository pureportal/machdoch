import { AnalyticsPrivacyControl } from "@machdoch/analytics/privacy-control";

export default function PrivacyPage(): React.ReactElement {
  return (
    <section className="grid max-w-xl gap-5">
      <h1 className="text-2xl font-semibold">Privacy</h1>
      <AnalyticsPrivacyControl />
    </section>
  );
}
