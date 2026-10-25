import { PostgresCloudDatabase } from "../src/server/cloud/database";
import { cloudCredentialsCipher } from "../src/server/cloud/credential-storage";
import {
  createCloudRuntime,
  setCloudRuntimeForTests,
} from "../src/server/cloud/runtime";

const database = new PostgresCloudDatabase(
  process.env.MACHDOCH_CLOUD_DATABASE_URL!,
);
await database.migrate();
setCloudRuntimeForTests(
  createCloudRuntime(database, process.env.MACHDOCH_CLOUD_ORIGIN!, {
    credentialsCipher: cloudCredentialsCipher(
      process.env.MACHDOCH_CLOUD_ENCRYPTION_KEY,
    ),
    modelAdapterFactory: async () => ({
      async startTurn(parameters) {
        if (parameters.userPrompt.includes("Unknown usage"))
          throw new Error("Provider connection ended without a usage receipt");
        return {
          text: "Controlled result",
          toolCalls: [],
          usage: { totalTokens: 250 },
        };
      },
      async continueTurn() {
        throw new Error("Unexpected continuation");
      },
    }),
  }),
);
await import("../src/server");
