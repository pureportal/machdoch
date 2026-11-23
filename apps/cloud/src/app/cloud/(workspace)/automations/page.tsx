import { redirect } from "next/navigation";

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{ automation?: string }>;
}) {
  const { automation } = await searchParams;
  redirect(automation ? `/cloud/loops/${automation}` : "/cloud/loops");
}
