# Near-Field Customer Speaker Field Acceptance Runbook

This runbook is the field acceptance workflow for validating a real Near-Field Customer Speaker on the Win10/Tauri production runtime. It is a human acoustic acceptance check for customer-facing Machine Audio playback, not a default automated test.

## Scope

Use this workflow when installing, replacing, moving, or re-aiming the speaker used for customer-facing audio cues on a production vending machine.

The accepted hardware target is a wired, low-power, near-field speaker that is directionally installed toward the Customer Audio Zone. It must be not Bluetooth and not public-address style. Do not install a speaker intended to broadcast across the venue.

Production binds the customer speaker to the stable WASAPI output endpoint ID shown by the Machine Runtime Console. Customer audio must use that configured endpoint ID; it must not rely on the OS default output. If the endpoint is missing or its stable ID changes after a hardware replacement, select the replacement endpoint, run the test at the intended form volume, and save a new confirmed binding.

## Preconditions

1. The machine is in a maintenance window and is not serving customers.
2. The Machine Runtime Console is running on the Win10/Tauri production runtime.
3. The speaker is physically mounted, wired, powered if needed, and aimed at the Customer Audio Zone.
4. The intended physical output appears in the Console's customer-speaker endpoint list with its stable endpoint ID.
5. Operator access to protected maintenance is available.

## Acceptance Workflow

1. Enter protected maintenance on the Machine Runtime Console.
2. Open Customer Speaker Binding and select the intended stable endpoint ID. Do not use the Windows default-output indicator as acceptance evidence.
3. Set the intended Machine Audio form volume. A 0% volume cannot be confirmed or saved.
4. Start test playback for that selected endpoint and form volume.
5. Confirm the software playback diagnostic changed through the expected local states:
   - requested
   - started
   - completed
6. If playback reports failed, stop acceptance and record the failure, selected stable endpoint ID, observed driver, operator, time, and corrective action.
7. Stand in the Customer Audio Zone and confirm the test audio is clear inside the Customer Audio Zone.
8. Stand outside the Customer Audio Zone at the nearest normal bystander positions and confirm the test audio is unobtrusive outside it.
9. Check "I heard the test audio" only after that completed test. The Console clears this confirmation if the endpoint or form volume changes.
10. Save the binding only when both acoustic checks pass. The saved confirmation is bound to the endpoint ID and form volume used by the completed test.
11. Adjust speaker aim or output volume as needed, then repeat the selected-endpoint test and confirmation.

## Evidence

Record the following in the field log:

- Machine code and location.
- Operator name.
- Date and time.
- Speaker model or installation note.
- Stable WASAPI endpoint ID and friendly name selected at the time of the check.
- Machine Audio Test Playback software result: requested, started, completed, or failed.
- Operator confirmation that audio is clear inside the Customer Audio Zone.
- Operator confirmation that audio is unobtrusive outside it.
- The tested form volume and any endpoint or speaker-aim changes made during acceptance.

## Boundaries

This workflow is human field acceptance and is not part of default E2E/CI. Automated browser, unit, and E2E tests verify playback requests and diagnostics with mock or browser drivers; they do not prove that a real speaker is mounted, aimed, or audible in the field.

Machine Audio playback success is customer-experience evidence only. It must not be treated as sale readiness evidence, payment evidence, dispensing evidence, refund evidence, or manual-handling evidence. Those workflows remain governed by the production SOP, payment recovery, fulfillment recovery, inventory, and maintenance-lock procedures.
