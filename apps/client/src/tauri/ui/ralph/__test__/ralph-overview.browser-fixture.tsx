import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { RalphOverview } from "../components/ralph-overview";
import type { RalphOverviewSelection } from "../ralph-overview-model";
import {
  createOverviewLibrary,
  createOverviewRun,
  createOverviewTask,
} from "./ralph-overview-fixtures";

declare global {
  interface Window {
    ralphOverviewFixture: {
      selection: RalphOverviewSelection | null;
      complete: () => void;
    };
  }
}

const initialLibraries = [
  createOverviewLibrary("C:/Development/commerce/api"),
  createOverviewLibrary("C:/Development/payments/api"),
  {
    ...createOverviewLibrary("C:/Development/website"),
    runs: [createOverviewRun()],
  },
  { ...createOverviewLibrary("C:/Development/empty"), flows: [] },
  createOverviewLibrary("C:/Development/commerce/api", "user"),
];
initialLibraries[0]!.flows.push({
  ...initialLibraries[0]!.flows[0]!,
  id: "review",
  name: "Review changes",
});

const Fixture = () => {
  const [tasks, setTasks] = useState([
    createOverviewTask("C:/Development/commerce/api", "first"),
    createOverviewTask("C:/Development/payments/api", "second"),
  ]);
  const [libraries, setLibraries] = useState(initialLibraries);
  window.ralphOverviewFixture ??= { selection: null, complete: () => {} };
  window.ralphOverviewFixture.complete = () => {
    setTasks((current) => current.filter((task) => task.id !== "first"));
    setLibraries((current) =>
      current.map((library) =>
        library.key === initialLibraries[0]!.key
          ? { ...library, runs: [createOverviewRun()] }
          : library,
      ),
    );
  };
  return (
    <RalphOverview
      libraries={libraries}
      tasks={tasks}
      taskError={null}
      tasksLoaded
      workspaceRoot="C:/Development/commerce/api"
      onOpen={(selection) => {
        window.ralphOverviewFixture.selection = selection;
      }}
      onRefresh={() => {}}
      onChooseWorkspace={() => {}}
    />
  );
};

createRoot(document.getElementById("root")!).render(<Fixture />);
