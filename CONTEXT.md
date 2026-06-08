# VEM

VEM manages vending machines, their purchase flow, and the operational signals needed to keep those machines usable in the field.

## Language

**Machine Command**:
An instruction that asks a vending machine to perform a prompt physical action and report whether it was accepted and completed.
_Avoid_: Remote operation, maintenance task

**Machine Environment Reading**:
A recent measurement of the physical environment inside or around a vending machine, such as temperature and relative humidity.
_Avoid_: Weather, sensor command

**Environment Control Command**:
A machine command that changes the vending machine environment, such as switching air conditioning or setting its target temperature.
_Avoid_: Remote operation, sensor reading

**Machine Availability Status**:
A vending machine's high-level availability for operations such as accepting orders and dispensing goods.
_Avoid_: Sensor status, environment status

**Machine Planogram**:
A vending machine's operating layout that maps slots to products and their intended merchandising quantities and sale presentation.
_Avoid_: Machine stock, inventory count

**Machine Planogram Version**:
An immutable version of a vending machine's planogram used to interpret orders, dispensing commands, and machine stock movements created while that layout was active.
_Avoid_: Catalog timestamp, inventory version

**Machine Sale View**:
The customer-facing sale view a vending machine presents from its active planogram, local stock ledger, slot sales state, and platform sale authorization rules.
_Avoid_: Catalog, product list

**Machine Sale Readiness**:
A vending machine's current ability to start a network-authorized sale, based on platform reachability, authentication, payment options, synchronization health, and required local capabilities.
_Avoid_: Saleable stock, slot sales state

**Slot Sales State**:
A vending machine slot's local sales eligibility, based on its stock level and machine-observed faults.
_Avoid_: Machine availability status, product status

**Saleable Stock**:
The portion of a vending machine's local stock that is eligible to be offered for sale after stock level, slot faults, and machine conditions are considered.
_Avoid_: Physical stock, platform available quantity

**Machine Local Stock Ledger**:
A vending machine's own record of the stock it believes is physically present in its slots, derived from machine-observed events such as dispensing, refill, and stock count correction.
_Avoid_: Machine catalog cache, platform inventory

**Machine Stock Movement**:
A machine-observed change to the stock believed to be physically present in a vending machine slot, such as dispensing, refill, or stock count correction.
_Avoid_: Platform inventory movement, catalog refresh

**Planned Refill**:
A scheduled service visit in which a vending machine is restocked and the actual quantities placed into its slots are recorded.
_Avoid_: Catalog refresh, stock count correction

**Stock Count Correction**:
A field adjustment that records the observed stock in a vending machine slot when it differs from the machine local stock ledger.
_Avoid_: Planned refill, catalog update

**Stock Reconciliation**:
The process of explaining and resolving differences between platform inventory records and a vending machine's local stock ledger.
_Avoid_: Automatic overwrite, catalog refresh

**Network-Authorized Sale**:
A sale in which the vending machine must receive platform authorization before accepting payment or dispensing goods.
_Avoid_: Offline sale, local-only sale

**Payment State**:
An order's payment-side lifecycle, such as awaiting payment, paid, canceled, expired, refunding, or refunded.
_Avoid_: Fulfillment state, vending state

**Fulfillment State**:
An order's vending-side lifecycle, such as not dispatched, dispatching, dispensing, dispensed, dispense failed, or manual handling.
_Avoid_: Payment state, order status

**Lower Controller**:
The embedded controller in a vending machine that executes physical dispensing and environment-control actions requested by the application.
_Avoid_: Serial device, USB device, hardware adapter

**Environment Capability Fault**:
A fault in a machine's environment sensing or control capability that does not by itself mean the machine is unavailable for sales.
_Avoid_: Offline machine, maintenance status

**Remote Operation**:
A maintenance request that a vending machine may pick up and complete asynchronously outside the customer purchase flow.
_Avoid_: Machine command
