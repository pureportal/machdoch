import {
  InstructionManager as SharedInstructionManager,
  type InstructionManagementControls,
} from "@machdoch/client-ui/instructions";
import { instructionRuntime } from "./instruction-runtime";

export function InstructionManager(props: {
  setup: InstructionManagementControls;
  onDirtyChange?: (dirty: boolean) => void;
}): React.ReactElement {
  return (
    <SharedInstructionManager {...props} runtime={instructionRuntime} />
  );
}
