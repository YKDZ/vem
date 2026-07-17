# Near-Field Customer Speaker Field Acceptance Runbook

This runbook is the field acceptance workflow for validating a real Near-Field Customer Speaker on the Win10/Tauri production runtime. It is a human acoustic acceptance check for customer-facing Machine Audio playback, not a default automated test.

## Scope

Use this workflow when installing, replacing, moving, or re-aiming the speaker used for customer-facing audio cues on a production vending machine.

The accepted hardware target is a wired, low-power, near-field speaker that is directionally installed toward the Customer Audio Zone. It must be not Bluetooth and not public-address style. Do not install a speaker intended to broadcast across the venue.

Customer audio uses the current Windows default output. The field check confirms
that this default output reaches the installed near-field speaker; it does not
select, bind, or persist an endpoint identity.

## Preconditions

1. The machine is in a maintenance window and is not serving customers.
2. The Machine Runtime Console is running on the Win10/Tauri production runtime.
3. The speaker is physically mounted, wired, powered if needed, and aimed at the Customer Audio Zone.
4. Windows default output is available through the installed speaker.
5. Operator access to protected maintenance is available.

## Acceptance Workflow

1. Enter protected maintenance on the Machine Runtime Console.
2. Confirm the Console reports Windows default output as available.
3. Set the intended Machine Audio form volume. A 0% volume cannot be confirmed.
4. Start test playback through Windows default output at that form volume.
5. Confirm the software playback diagnostic changed through the expected local states:
   - requested
   - started
   - completed
6. If playback reports failed, stop acceptance and record the failure, observed default-output state, operator, time, and corrective action.
7. Stand in the Customer Audio Zone and confirm the test audio is clear inside the Customer Audio Zone.
8. Stand outside the Customer Audio Zone at the nearest normal bystander positions and confirm the test audio is unobtrusive outside it.
9. Check "I heard the test audio" only after that completed test. The Console clears this confirmation if the form volume changes.
10. Record acceptance only when both acoustic checks pass.
11. Adjust speaker aim or output volume as needed, then repeat the Windows-default-output test and confirmation.

## Evidence

Record the following in the field log:

- Machine code and location.
- Operator name.
- Date and time.
- Speaker model or installation note.
- Confirmation that Windows default output was available at the time of the check.
- Machine Audio Test Playback software result: requested, started, completed, or failed.
- Operator confirmation that audio is clear inside the Customer Audio Zone.
- Operator confirmation that audio is unobtrusive outside it.
- The tested form volume and any speaker-aim changes made during acceptance.

## Boundaries

This workflow is human field acceptance and is not part of default E2E/CI. Automated browser, unit, and E2E tests verify playback requests and diagnostics with mock or browser drivers; they do not prove that a real speaker is mounted, aimed, or audible in the field.

Machine Audio playback success is customer-experience evidence only. It must not be treated as sale readiness evidence, payment evidence, dispensing evidence, refund evidence, or manual-handling evidence. Those workflows remain governed by the production SOP, payment recovery, fulfillment recovery, inventory, and maintenance-lock procedures.
