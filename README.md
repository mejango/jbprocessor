# JBProcessor

JBProcessor lets someone pay a Juicebox V6 project with a credit card. Stripe collects the
fiat charge, a backend worker converts it to USDC and pays the project onchain, and the
resulting project tokens sit in an onchain escrow contract (`contracts/src/JBProcessorEscrow.sol`)
for a card-dispute window before they're released to the buyer — so a chargeback can claw the
tokens back instead of leaving the project (or JBProcessor) holding the loss. See
`.superpowers/sdd/jbprocessor-plan-2026-08-11/` for the full build plan; this README will be
expanded with setup and architecture docs once the service is wired end-to-end.
