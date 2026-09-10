import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SessionMemoryDialog } from "./memory-management";
import "./styles.css";

declare global {
  interface Window {
    memoryDialogFixture: {
      update: (changes: {
        disabled?: boolean;
        mounted?: boolean;
        opener?: boolean;
      }) => void;
      unmount: () => void;
      closeCount: number;
      backgroundCount: number;
    };
  }
}

function Fixture() {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState({
    disabled: false,
    mounted: true,
    opener: true,
  });
  window.memoryDialogFixture.update = (changes) => {
    flushSync(() => setOptions((previous) => ({ ...previous, ...changes })));
  };

  return (
    <div className="machdoch-product">
      {options.opener && (
        <button id="opener" onClick={() => setOpen(true)}>
          Open memory
        </button>
      )}
      {options.mounted && (
        <SessionMemoryDialog
          open={open}
          enabled
          disabled={options.disabled}
          entries={[
            { id: "one", content: "First memory", createdAt: 1 },
            { id: "two", content: "Second memory", createdAt: 2 },
          ]}
          onEnabledChange={() => {}}
          onForget={() => {}}
          onClose={() => {
            window.memoryDialogFixture.closeCount += 1;
            setOpen(false);
          }}
        />
      )}
      <button
        id="background"
        style={{ position: "fixed", right: 0, top: 0 }}
        onClick={() => {
          window.memoryDialogFixture.backgroundCount += 1;
        }}
      >
        Background
      </button>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
window.memoryDialogFixture = {
  update: () => {},
  unmount: () => flushSync(() => root.unmount()),
  closeCount: 0,
  backgroundCount: 0,
};
flushSync(() =>
  root.render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  ),
);
