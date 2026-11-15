import { requireManagerPage } from "@/server/page-auth";
import { EnrollmentView } from "./enrollment-view";

export const dynamic = "force-dynamic";

export default async function EnrollmentPage(): Promise<React.ReactElement> {
  await requireManagerPage();
  return <EnrollmentView />;
}
