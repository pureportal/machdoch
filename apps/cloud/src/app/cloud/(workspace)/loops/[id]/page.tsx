import { redirect } from "next/navigation";

export default async function LoopPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const [{ id }, { run }] = await Promise.all([params, searchParams]);
  const query = run ? `?run=${encodeURIComponent(run)}` : "";
  redirect(`/cloud/automations/${encodeURIComponent(id)}${query}`);
}
