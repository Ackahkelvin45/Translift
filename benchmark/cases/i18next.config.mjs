// Minimal config so `i18next-cli lint` can scan the benchmark cases.
export default {
  locales: ["en"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    output: "locales/{{language}}/{{namespace}}.json",
  },
};
