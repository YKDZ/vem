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

**Remote Operation**:
A maintenance request that a vending machine may pick up and complete asynchronously outside the customer purchase flow.
_Avoid_: Machine command
