// Enter kosong → lanjutkan agent tanpa input.
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type KeyId = Parameters<CustomEditor["handleInput"]>[0];
let busy = false;

class Editor extends CustomEditor {
	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: Parameters<CustomEditor["constructor"]>[1],
		keybindings: Parameters<CustomEditor["constructor"]>[2],
		private onEmptyEnter: () => void,
	) {
		super(tui, theme, keybindings);
	}
	handleInput(data: KeyId) {
		if (
			this.keybindings.matches(data, "tui.input.submit") &&
			!this.disableSubmit &&
			!this.isShowingAutocomplete() &&
			this.getText().trim() === ""
		) {
			this.setText("");
			this.onEmptyEnter();
			return;
		}
		return super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", () => (busy = true));
	pi.on("agent_settled", () => (busy = false));
	pi.on("session_start", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, kb) =>
			new Editor(tui, theme, kb, () => {
				if (busy) return;
				pi.sendMessage(
					{ customType: "continue", content: "", display: false },
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}),
		);
	});
}