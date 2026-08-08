/**
 * tui — bundles the token-speed indicator and path-border extensions
 * into a single auto-discovered entry point (extensions subdir index.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tok from "./tok.ts";
import path from "./path.ts";

export default function (pi: ExtensionAPI) {
	tok(pi);
	path(pi);
}
