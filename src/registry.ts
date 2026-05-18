import { SinkRegistry } from "./types";

export const DEFAULT_REGISTRY: SinkRegistry = {
  components: [
    { name: "Toast", uiProps: "all-children" },
    { name: "Modal", uiProps: ["title"] },
    { name: "Alert", uiProps: "all-children" },
    { name: "Dialog", uiProps: ["title", "description"] },
    { name: "Tooltip", uiProps: ["content", "title"] },
  ],
  attributes: [
    { name: "aria-label" },
    { name: "aria-description" },
    { name: "placeholder" },
    { name: "alt" },
    { name: "title", notOnElements: ["a", "abbr", "iframe"] },
  ],
  functions: [
    { name: "toast", importFrom: "react-hot-toast", uiArgs: [0] },
    { name: "toast", importFrom: "sonner", uiArgs: [0] },
    { name: "alert", uiArgs: [0] },
    { name: "confirm", uiArgs: [0] },
  ],
};
