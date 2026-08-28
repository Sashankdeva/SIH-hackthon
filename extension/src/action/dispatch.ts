import { executeAction } from "./executor";
import type { ActionRequest } from "./types";

export interface ActionDispatch {
  /**
   * Executes the action the first time it is called and returns true.
   * Every later call is refused and returns false — it never reaches
   * executeAction.
   */
  run(action: ActionRequest): Promise<boolean>;
  readonly executed: boolean;
}

/**
 * One server action must produce AT MOST ONE browser interaction.
 *
 * This exists because that guarantee was previously only implicit, and
 * it broke: the pipeline verified an action, read "ambiguous" (which is
 * what URL-based verification returns for every action that isn't a
 * navigation), treated that as "it failed", and re-entered the whole
 * step — re-executing the action it had already performed. A click on
 * "Place Order" placed two orders. See docs/ARCHITECTURE.md.
 *
 * An unverified outcome is not evidence that nothing happened, so the
 * cure is not a smarter retry rule. The invariant is made structural
 * instead: a fresh gate is created per server response, and it opens
 * once. A caller that loops (the multi-step driver, when it lands)
 * cannot re-execute an action it already dispatched, and a caller that
 * tries is told so loudly rather than silently doubling a side effect.
 *
 * The flag is set BEFORE awaiting so that a second call arriving while
 * the first execution is still in flight is refused too — `wait` and
 * `type_secret` both await, and both are re-entrant otherwise.
 */
export function createDispatch(actionId: string): ActionDispatch {
  let executed = false;

  return {
    get executed() {
      return executed;
    },
    async run(action: ActionRequest): Promise<boolean> {
      if (executed) {
        console.error(
          `[dispatch] refusing to execute ${actionId} a second time (action: ${action.action}) —`,
          "one server action is one browser interaction."
        );
        return false;
      }
      executed = true;
      await executeAction(action);
      return true;
    },
  };
}
