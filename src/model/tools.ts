export const TOOLS = [
  {
    type: "function",
    function: {
      name: "open_tab",
      description: "Open an https URL in a new tab. The host must already be allowlisted.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Go to an https URL in the current tab. The host must already be allowlisted.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description: "Read the current page: title, visible text, and numbered controls (the first 80, visible ones first).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click one numbered control from the latest read_page result.",
      parameters: {
        type: "object",
        properties: { ref: { type: "integer" } },
        required: ["ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "Type text into one numbered text control. Password and payment fields are blocked.",
      parameters: {
        type: "object",
        properties: { ref: { type: "integer" }, text: { type: "string" } },
        required: ["ref", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find",
      description: "Search all controls from the latest read_page by label or link. Returns matching control numbers.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_enter",
      description: "Press Enter in a numbered search box or single-line field, for example to run a search.",
      parameters: {
        type: "object",
        properties: { ref: { type: "integer" } },
        required: ["ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the current page vertically by dy pixels.",
      parameters: {
        type: "object",
        properties: { dy: { type: "integer" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_back",
      description: "Go back one page in the current tab.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_to_post",
      description:
        "Ask the user to approve a post. Jeco types the exact text into the field, shows it, and presses the post button only after the user approves.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          field: { type: "integer", description: "The text field from read_page." },
          button: { type: "integer", description: "Optional post button from read_page." },
        },
        required: ["text", "field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "End the task and tell the user the result.",
      parameters: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    },
  },
];

