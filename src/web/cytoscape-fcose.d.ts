/**
 * cytoscape-fcose@2.2.0 ships no type declarations; this mirrors the
 * @types/cytoscape extension-registry contract (see its `Ext` docs).
 * Global script file (no top-level imports) so `declare module` stays
 * ambient rather than becoming an augmentation.
 */
declare module 'cytoscape-fcose' {
  const fcose: import('cytoscape').Ext;
  export = fcose;
}
