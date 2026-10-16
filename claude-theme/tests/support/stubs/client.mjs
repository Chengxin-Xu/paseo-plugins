// The client SDK's hooks come from the Paseo app; views are imported, not rendered, in these tests.
const unavailable = (name) => () => {
  throw new Error(`${name} is only available inside the Paseo app`);
};
export const usePaseo = unavailable("usePaseo");
export const useRpc = unavailable("useRpc");
export const useSettings = unavailable("useSettings");
export const useAgent = unavailable("useAgent");
export const useWorkspace = unavailable("useWorkspace");
