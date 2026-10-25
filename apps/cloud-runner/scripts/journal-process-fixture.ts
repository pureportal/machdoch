import { RunnerJournal } from "../../../packages/cloud-client/src/worker/journal.ts";
import { claimFixture } from "../src/test-fixture.ts";

const journal = new RunnerJournal(process.argv[2]!, "https://cloud.example.test");
journal.plan();
journal.transition("claiming");
const job = journal.transition("claimed", { claim: claimFixture() });
process.send?.(job);
setInterval(() => {}, 10000);
