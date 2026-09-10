/** A validated relative Markdown path accepted by the vault boundary. */
export type NotePath = string & { readonly __brand: "NotePath" };
