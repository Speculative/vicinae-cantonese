/// <reference types="@vicinae/api">

/*
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 */

type ExtensionPreferences = {
  /** Script - Which character set to paste and show first */
	"script"?: "traditional" | "simplified";

	/** Detail Pane - Toggle at any time with Ctrl+D */
	"showDetail"?: boolean;
}

declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Command: Cantonese Lookup */
	export type Cantonese = ExtensionPreferences & {
		
	}
}

declare namespace Arguments {
  /** Command: Cantonese Lookup */
	export type Cantonese = {
		
	}
}