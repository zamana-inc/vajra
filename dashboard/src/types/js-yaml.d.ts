declare module "js-yaml" {
  const yaml: {
    load: (input: string, options?: unknown) => unknown;
    loadAll: (input: string, iterator?: (doc: unknown) => void, options?: unknown) => unknown[];
    dump: (obj: unknown, options?: unknown) => string;
  };

  export default yaml;
}
