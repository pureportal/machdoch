import { ExternalLink, KeyRound } from "lucide-react";
import { useId, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { ParsedField } from "../chat-session/components/settings-dialog-panels/parsed-field";
import {
  createAuth,
  createTransport,
  formatStringList,
  formatStringRecord,
  getAuthType,
  getRecord,
  getString,
  getTransportType,
  normalizeServerId,
  parseStringList,
  parseStringRecord,
  setRecordValue,
  TRANSPORT_TYPES,
  type AuthType,
  type ServerRecord,
  type TransportType,
} from "./mcp-config-model";
import {
  Field,
  IssueList,
  MCP_INPUT_CLASS,
  MCP_PROSE_TEXTAREA_CLASS,
  MCP_SECONDARY_BUTTON_CLASS,
  MCP_SELECT_CLASS,
  MCP_TEXT_INPUT_CLASS,
  MCP_TEXTAREA_CLASS,
  McpSection,
} from "./mcp-form-fields";
import type { McpServerEditor } from "./use-mcp-server-editor";

interface SectionProps {
  editor: McpServerEditor;
  server: ServerRecord;
}

const TextField = ({
  editor,
  record,
  label,
  field,
  placeholder,
  type,
}: {
  editor: McpServerEditor;
  record: "transport" | "auth";
  label: string;
  field: string;
  placeholder?: string;
  type?: "password";
}): JSX.Element => (
  <Field label={label}>
    <Input
      type={type}
      autoComplete={type === "password" ? "off" : undefined}
      value={getString(getRecord(editor.selectedServer, record), field)}
      disabled={editor.disabled}
      placeholder={placeholder}
      onChange={(event) =>
        editor.updateSelectedRecord(record, (current) =>
          setRecordValue(current, field, event.target.value),
        )
      }
      className={MCP_INPUT_CLASS}
    />
  </Field>
);

const RecordListField = ({
  editor,
  record,
  label,
  field,
  detail,
  placeholder,
}: {
  editor: McpServerEditor;
  record: "transport" | "auth";
  label: string;
  field: string;
  detail: string;
  placeholder?: string;
}): JSX.Element => (
  <Field label={label} detail={detail}>
    <ParsedField
      key={editor.selectedServerKey}
      value={getRecord(editor.selectedServer, record)?.[field]}
      format={formatStringRecord}
      parse={parseStringRecord}
      multiline
      disabled={editor.disabled}
      placeholder={placeholder}
      onChange={(value) =>
        editor.updateSelectedRecord(record, (current) =>
          setRecordValue(current, field, value),
        )
      }
      className={MCP_TEXTAREA_CLASS}
    />
  </Field>
);

export const McpSetupSection = ({
  editor,
  server,
}: SectionProps): JSX.Element => {
  const transport = getRecord(server, "transport");
  const transportType = getTransportType(server);

  return (
    <div className="grid gap-4">
      <IssueList issues={editor.selectedIssues} />
      <McpSection title="Identity">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="ID">
            <Input
              value={getString(server, "id")}
              disabled={editor.disabled}
              onChange={(event) =>
                editor.renameSelectedServer(
                  normalizeServerId(event.target.value),
                )
              }
              className={MCP_INPUT_CLASS}
            />
          </Field>
          <Field label="Title">
            <Input
              value={getString(server, "title")}
              disabled={editor.disabled}
              onChange={(event) =>
                editor.updateSelectedField("title", event.target.value)
              }
              className={MCP_TEXT_INPUT_CLASS}
            />
          </Field>
          <Field label="Description" className="md:col-span-2">
            <Textarea
              value={getString(server, "description")}
              disabled={editor.disabled}
              onChange={(event) =>
                editor.updateSelectedField("description", event.target.value)
              }
              className={MCP_PROSE_TEXTAREA_CLASS}
            />
          </Field>
        </div>
      </McpSection>

      <McpSection title="Transport">
        <div className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
          <Field label="Transport">
            <select
              value={transportType}
              disabled={editor.disabled}
              onChange={(event) =>
                editor.updateSelectedField(
                  "transport",
                  createTransport(
                    event.target.value as TransportType,
                    transport,
                  ),
                )
              }
              className={MCP_SELECT_CLASS}
            >
              {TRANSPORT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
          {transportType === "stdio" ? (
            <TextField
              editor={editor}
              record="transport"
              label="Command"
              field="command"
              placeholder="npx"
            />
          ) : (
            <TextField
              editor={editor}
              record="transport"
              label="URL"
              field="url"
              placeholder="https://example.com/mcp"
            />
          )}
        </div>

        {transportType === "stdio" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Args"
              detail="One argument per line or comma separated."
            >
              <ParsedField
                key={editor.selectedServerKey}
                value={transport?.args}
                format={formatStringList}
                parse={parseStringList}
                multiline
                disabled={editor.disabled}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                onChange={(args) =>
                  editor.updateSelectedRecord("transport", (record) =>
                    setRecordValue(record, "args", args),
                  )
                }
                className={MCP_TEXTAREA_CLASS}
              />
            </Field>
            <RecordListField
              editor={editor}
              record="transport"
              label="Env"
              field="env"
              detail="KEY=value, one per line."
              placeholder="API_KEY=${env:API_KEY}"
            />
            <TextField
              editor={editor}
              record="transport"
              label="Working directory"
              field="cwd"
              placeholder="${workspaceRoot}"
            />
            <Field label="stderr">
              <select
                value={getString(transport, "stderr")}
                disabled={editor.disabled}
                onChange={(event) =>
                  editor.updateSelectedRecord("transport", (record) =>
                    setRecordValue(record, "stderr", event.target.value),
                  )
                }
                className={MCP_SELECT_CLASS}
              >
                <option value="">Default</option>
                <option value="pipe">pipe</option>
                <option value="inherit">inherit</option>
                <option value="ignore">ignore</option>
              </select>
            </Field>
          </div>
        ) : (
          <RecordListField
            editor={editor}
            record="transport"
            label="Headers"
            field="headers"
            detail="KEY=value, one per line."
          />
        )}
      </McpSection>
    </div>
  );
};

const OAuthAuthorization = ({
  editor,
}: {
  editor: McpServerEditor;
}): JSX.Element => {
  const { setup, selectedServerId } = editor;
  const unavailable = editor.actionDisabled || !selectedServerId;
  const callbackHintId = useId();

  return (
    <SubmitShortcut asChild>
      <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-slate-200">Authorization</p>
          <Button
            type="button"
            variant="outline"
            disabled={unavailable}
            onClick={() => {
              void setup.onStartOAuth(selectedServerId);
            }}
            className={MCP_SECONDARY_BUTTON_CLASS}
          >
            <ExternalLink className="size-4" />
            Start OAuth
          </Button>
        </div>
        {!setup.commandsAvailable ? (
          <p className="text-xs text-slate-500">
            Select a workspace to authorize this server.
          </p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field label="OAuth callback URL or code">
            <Input
              aria-label="MCP OAuth callback URL or code"
              aria-describedby={callbackHintId}
              value={editor.oauthCallback}
              placeholder="callback URL or code"
              disabled={editor.actionDisabled}
              onChange={(event) => editor.setOauthCallback(event.target.value)}
              className={MCP_INPUT_CLASS}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={unavailable}
            onClick={() => {
              void setup.onFinishOAuth(selectedServerId, editor.oauthCallback);
            }}
            {...SUBMIT_SHORTCUT_ACTION_PROPS}
            className={MCP_SECONDARY_BUTTON_CLASS}
          >
            <KeyRound className="size-4" />
            Finish OAuth
          </Button>
        </div>
        <p
          id={callbackHintId}
          className="-mt-1 text-xs leading-5 text-slate-500"
        >
          Only needed when the browser redirect does not complete.
        </p>
      </div>
    </SubmitShortcut>
  );
};

export const McpAuthSection = ({
  editor,
  server,
}: SectionProps): JSX.Element => {
  const auth = getRecord(server, "auth");
  const authType = getAuthType(server);

  return (
    <McpSection title="Authentication">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Auth">
          <select
            value={authType}
            disabled={editor.disabled}
            onChange={(event) =>
              editor.updateSelectedField(
                "auth",
                createAuth(event.target.value as AuthType, auth),
              )
            }
            className={MCP_SELECT_CLASS}
          >
            <option value="none">none</option>
            <option value="bearer">bearer</option>
            <option value="headers">headers</option>
            <option value="oauth">oauth</option>
          </select>
        </Field>
        <Field label="Security">
          <select
            value={getString(server, "securityProfile") || "weak"}
            disabled={editor.disabled}
            onChange={(event) =>
              editor.updateSelectedField("securityProfile", event.target.value)
            }
            className={MCP_SELECT_CLASS}
          >
            <option value="weak">Weak</option>
            <option value="balanced">Balanced</option>
            <option value="strict">Strict</option>
          </select>
        </Field>
      </div>

      {authType === "bearer" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            editor={editor}
            record="auth"
            label="Token env"
            field="tokenEnv"
            placeholder="GITHUB_PERSONAL_ACCESS_TOKEN"
          />
          <TextField
            editor={editor}
            record="auth"
            label="Token"
            field="token"
            type="password"
          />
          <TextField
            editor={editor}
            record="auth"
            label="Header name"
            field="headerName"
            placeholder="Authorization"
          />
        </div>
      ) : null}

      {authType === "headers" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <RecordListField
            editor={editor}
            record="auth"
            label="Headers"
            field="headers"
            detail="KEY=value, one per line."
          />
          <RecordListField
            editor={editor}
            record="auth"
            label="Env headers"
            field="envHeaders"
            detail="Header=ENV_VAR, one per line."
          />
        </div>
      ) : null}

      {authType === "oauth" ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              editor={editor}
              record="auth"
              label="Client ID"
              field="clientId"
            />
            <TextField
              editor={editor}
              record="auth"
              label="Client secret env"
              field="clientSecretEnv"
            />
            <TextField
              editor={editor}
              record="auth"
              label="Redirect URL"
              field="redirectUrl"
            />
            <Field label="Scopes">
              <ParsedField
                key={editor.selectedServerKey}
                value={auth?.scopes}
                format={(value) =>
                  formatStringList(value).replace(/\n/gu, ", ")
                }
                parse={parseStringList}
                disabled={editor.disabled}
                onChange={(scopes) =>
                  editor.updateSelectedRecord("auth", (record) =>
                    setRecordValue(record, "scopes", scopes),
                  )
                }
                className={MCP_INPUT_CLASS}
              />
            </Field>
            <TextField
              editor={editor}
              record="auth"
              label="Access token env"
              field="accessTokenEnv"
            />
            <TextField
              editor={editor}
              record="auth"
              label="Refresh token env"
              field="refreshTokenEnv"
            />
          </div>
          <OAuthAuthorization editor={editor} />
        </>
      ) : null}
    </McpSection>
  );
};
