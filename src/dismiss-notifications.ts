import { showHUD } from "@raycast/api";
import { runAppleScript, showFailureToast } from "@raycast/utils";
export default async function main() {
  try {
    const res = await runAppleScript(`
	    tell application "System Events" to tell application process "NotificationCenter"
		try
			repeat with uiElement in (actions of UI elements of scroll area 1 of group 1 of group 1 of window "Notification Center" of application process "NotificationCenter" of application "System Events")
				if description of uiElement contains "Close" then
					perform uiElement
				end if
				if description of uiElement contains "Clear" then
					perform uiElement
				end if
				if description of uiElement contains "Clear All" then
					perform uiElement
				end if
			end repeat
			return ""
		end try
	end tell
	  `);
    await showHUD("Dismissed notifications" + res);
  } catch (error) {
    showFailureToast(error, { title: "Could not run AppleScript" });
  }
}
