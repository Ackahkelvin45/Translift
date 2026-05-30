// Non-UI strings — must NOT be wrapped (false-positive traps).
export function setup() {
  console.log("initializing analytics module");
  const endpoint = "https://api.example.com/v2/data";
  return endpoint;
}
