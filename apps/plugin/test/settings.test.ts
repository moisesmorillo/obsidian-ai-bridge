import { describe, expect, it, vi } from "vitest";

/** Captured text input and callback used by the settings control mock. */
interface CapturedText {
	value: string;
	placeholder: string;
	blur: (() => Promise<void>) | null;
}

/** Captured button label and action used by the settings control mock. */
interface CapturedButton {
	label: string;
	disabled: boolean;
	onClick: (() => void | Promise<void>) | null;
}

/** One rendered settings row and the controls attached to it. */
interface CapturedToggle {
	value: boolean;
	onChange: ((value: boolean) => Promise<void>) | null;
}

/** Captured settings row and the controls rendered for its owner decision. */
interface CapturedSetting {
	name: string;
	description: string;
	text: CapturedText | null;
	buttons: CapturedButton[];
	toggles: CapturedToggle[];
}

/** Safe text element captured from the synthetic settings container. */
interface CapturedElement {
	textContent: string;
	/** Replaces the visible safe status text. */
	setText(text: string): void;
}

const host = vi.hoisted(() => ({
	controls: [] as CapturedSetting[],
	elements: [] as CapturedElement[],
}));

vi.mock("obsidian", () => ({
	PluginSettingTab: class {
		containerEl = {
			/** Clears rows before the tab renders again. */
			empty: () => {
				host.controls.splice(0);
				host.elements.splice(0);
			},
			/** Captures the fixed text elements rendered by the settings tab. */
			createEl: (_tag: string, options: { text: string }) => {
				const element: CapturedElement = {
					textContent: options.text,
					/** Replaces the visible text in the synthetic element. */
					setText(text) {
						this.textContent = text;
					},
				};
				host.elements.push(element);
				return element;
			},
		} as unknown as HTMLElement;
	},
	Setting: class {
		private readonly row: CapturedSetting;

		/** Starts one captured row for the Obsidian Setting chain. */
		constructor(_container: HTMLElement) {
			this.row = {
				name: "",
				description: "",
				text: null,
				buttons: [],
				toggles: [],
			};
			host.controls.push(this.row);
		}

		/** Captures the visible row name. */
		setName(name: string): this {
			this.row.name = name;
			return this;
		}

		/** Captures the visible row description. */
		setDesc(description: string): this {
			this.row.description = description;
			return this;
		}

		/** Captures input values and the blur handler. */
		addText(callback: (text: CapturedTextControl) => void): this {
			const captured: CapturedText = { value: "", placeholder: "", blur: null };
			const control: CapturedTextControl = {
				inputEl: {
					addEventListener: (event, listener) => {
						if (event === "blur") captured.blur = listener;
					},
				},
				setPlaceholder: (value) => {
					captured.placeholder = value;
					return control;
				},
				setValue: (value) => {
					captured.value = value;
					return control;
				},
				getValue: () => captured.value,
			};
			callback(control);
			this.row.text = captured;
			return this;
		}

		/** Captures toggle state and asynchronous change handlers. */
		addToggle(callback: (toggle: CapturedToggleControl) => void): this {
			const captured: CapturedToggle = { value: false, onChange: null };
			const control: CapturedToggleControl = {
				setValue: (value) => {
					captured.value = value;
					return control;
				},
				onChange: (handler) => {
					captured.onChange = handler;
					return control;
				},
			};
			callback(control);
			this.row.toggles.push(captured);
			return this;
		}

		/** Captures button labels, state changes, and click handlers. */
		addButton(callback: (button: CapturedButtonControl) => void): this {
			const captured: CapturedButton = {
				label: "",
				disabled: false,
				onClick: null,
			};
			const control: CapturedButtonControl = {
				setButtonText: (label) => {
					captured.label = label;
					return control;
				},
				onClick: (handler) => {
					captured.onClick = handler;
					return control;
				},
				setDisabled: (disabled) => {
					captured.disabled = disabled;
					return control;
				},
			};
			callback(control);
			this.row.buttons.push(captured);
			return this;
		}
	},
}));

/** Text methods exposed by the mock control to the production settings tab. */
interface CapturedTextControl {
	inputEl: {
		/** Stores the blur callback that controls server URL persistence. */
		addEventListener(event: string, listener: () => Promise<void>): void;
	};
	/** Sets the example HTTPS service origin. */
	setPlaceholder(value: string): CapturedTextControl;
	/** Sets the current value shown in the synthetic input. */
	setValue(value: string): CapturedTextControl;
	/** Returns the current synthetic input value. */
	getValue(): string;
}

/** Button methods exposed by the mock control to the production settings tab. */
interface CapturedToggleControl {
	/** Sets the synthetic toggle value. */
	setValue(value: boolean): CapturedToggleControl;
	/** Stores the callback for a user change. */
	onChange(handler: (value: boolean) => Promise<void>): CapturedToggleControl;
}

/** Button methods exposed by the mock control to the production settings tab. */
interface CapturedButtonControl {
	/** Sets the label shown by the synthetic button. */
	setButtonText(label: string): CapturedButtonControl;
	/** Stores the settings action for later test invocation. */
	onClick(handler: () => void | Promise<void>): CapturedButtonControl;
	/** Sets the synthetic disabled state. */
	setDisabled(disabled: boolean): CapturedButtonControl;
}

import type { App, Plugin } from "obsidian";
import type { DeviceSession } from "../src/auth/device-session";
import type { CredentialStorage } from "../src/infrastructure/credential-storage";
import { type AIBridgeSettings, AIBridgeSettingTab } from "../src/settings";

/** Creates a settings tab with safe synthetic controller and storage effects. */
function createTab() {
	host.controls.splice(0);
	host.elements.splice(0);
	const settings: AIBridgeSettings = {
		serverUrl: "https://service.test",
		deviceName: "Obsidian desktop",
		coexistenceMode: false,
	};
	let status: "connected" | "disconnected" = "connected";
	const session = {
		connect: vi.fn(),
		cancel: vi.fn(),
	} as unknown as DeviceSession;
	const credentials = {
		warning: "tokens stored unencrypted on this device",
	} as CredentialStorage;
	const updates: string[] = [];
	const deviceNameUpdates: string[] = [];
	const coexistenceUpdates: boolean[] = [];
	let rejectCoexistenceUpdate = false;
	let rejectUpdate = false;
	let rejectDeviceNameUpdate = false;
	const tab = new AIBridgeSettingTab(
		{} as App,
		{} as Plugin,
		settings,
		() => session,
		credentials,
		async (url) => {
			updates.push(url);
			if (rejectUpdate) throw new Error("synthetic save failure");
		},
		async (name) => {
			deviceNameUpdates.push(name);
			if (rejectDeviceNameUpdate)
				throw new Error("synthetic name save failure");
		},
		async (enabled) => {
			coexistenceUpdates.push(enabled);
			if (rejectCoexistenceUpdate)
				throw new Error("synthetic coexistence save failure");
		},
		() => status,
	);
	tab.display();
	return {
		tab,
		settings,
		session,
		updates,
		deviceNameUpdates,
		coexistenceUpdates,
		setRejectCoexistenceUpdate: (value: boolean) => {
			rejectCoexistenceUpdate = value;
		},
		setStatus: (value: "connected" | "disconnected") => {
			status = value;
		},
		setRejectUpdate: (value: boolean) => {
			rejectUpdate = value;
		},
		setRejectDeviceNameUpdate: (value: boolean) => {
			rejectDeviceNameUpdate = value;
		},
	};
}

describe("AIBridgeSettingTab", () => {
	it("defaults coexistence off and restores the saved value after a failed write", async () => {
		const test = createTab();
		const row = host.controls.find((item) => item.name === "Coexistence mode");
		expect(row?.toggles[0]?.value).toBe(false);
		test.setRejectCoexistenceUpdate(true);
		await row?.toggles[0]?.onChange?.(true);
		expect(row?.toggles[0]?.value).toBe(false);
		test.setRejectCoexistenceUpdate(false);
		await row?.toggles[0]?.onChange?.(true);
		expect(test.settings.coexistenceMode).toBe(true);
		expect(test.coexistenceUpdates).toEqual([true, true]);
	});

	it("renders a device name field for distinct device identity", () => {
		createTab();
		const deviceName = host.controls.find((row) => row.name === "Device name");
		expect(deviceName?.text).not.toBeNull();
		expect(deviceName?.text?.value).toBe("Obsidian desktop");
	});

	it("renders safe status and connect and cancel actions", async () => {
		const test = createTab();
		expect(host.controls.map((row) => row.name)).toEqual([
			"Server URL",
			"Device name",
			"Coexistence mode",
			"Device connection",
		]);
		expect(host.controls[3]?.buttons.map((button) => button.label)).toEqual([
			"Connect",
			"Cancel",
		]);
		expect(host.elements.map((element) => element.textContent)).toContain(
			"Status: connected",
		);
		expect(host.elements.map((element) => element.textContent)).toContain(
			"tokens stored unencrypted on this device",
		);
		await host.controls[3]?.buttons[0]?.onClick?.();
		host.controls[3]?.buttons[1]?.onClick?.();
		expect(test.session.connect).toHaveBeenCalledOnce();
		expect(test.session.cancel).toHaveBeenCalledOnce();
		test.setStatus("disconnected");
		test.tab.refreshStatus();
		const status = host.elements.find((element) =>
			element.textContent.startsWith("Status:"),
		);
		expect(status?.textContent).toBe("Status: disconnected");
		expect(status?.textContent).not.toContain("token");
	});

	it("saves a distinct device name and restores the prior value on failure", async () => {
		const test = createTab();
		const input = host.controls[1]?.text;
		if (!input?.blur)
			throw new Error("Device name blur handler was not attached");
		input.value = "  oab-8.8 dev-1  ";
		await input.blur();
		expect(test.deviceNameUpdates).toEqual(["oab-8.8 dev-1"]);
		expect(test.settings.deviceName).toBe("oab-8.8 dev-1");
		test.setRejectDeviceNameUpdate(true);
		input.value = "failed device name";
		await input.blur();
		expect(input.value).toBe("oab-8.8 dev-1");
		expect(test.deviceNameUpdates).toEqual([
			"oab-8.8 dev-1",
			"failed device name",
		]);
	});

	it("saves a changed server origin and restores the prior value on failure", async () => {
		const test = createTab();
		const input = host.controls[0]?.text;
		if (!input?.blur)
			throw new Error("Server URL blur handler was not attached");
		input.value = "  https://next-service.test  ";
		await input.blur();
		expect(test.updates).toEqual(["https://next-service.test"]);
		expect(test.settings.serverUrl).toBe("https://next-service.test");
		test.setRejectUpdate(true);
		input.value = "https://failed-service.test";
		await input.blur();
		expect(input.value).toBe("https://next-service.test");
		expect(test.updates).toEqual([
			"https://next-service.test",
			"https://failed-service.test",
		]);
	});
});
