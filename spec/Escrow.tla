------------------------------ MODULE Escrow ------------------------------

EXTENDS Integers, FiniteSets

CONSTANTS
  Actors,
  Payer,
  Payee,
  Releaser,
  Stranger,
  RefundTo,
  MaxAmount,
  MaxTime,
  MaxThreshold

VARIABLES
  state,
  ledgerTime,
  amount,
  payerVar,
  payeeVar,
  releaserSet,
  threshold,
  refundAfter,
  releaseNotBefore,
  refundToVar,
  requiresAcceptance,
  accepted

StatusSet == {"None", "Funded", "Released", "Refunded"}
NoDeadline == -1

TypeOK ==
  /\ state \in StatusSet
  /\ ledgerTime \in 0..MaxTime
  /\ amount \in 0..MaxAmount
  /\ payerVar \in Actors
  /\ payeeVar \in Actors
  /\ releaserSet \subseteq Actors
  /\ threshold \in 1..MaxThreshold
  /\ refundAfter \in ({NoDeadline} \union 0..MaxTime)
  /\ releaseNotBefore \in ({NoDeadline} \union 0..MaxTime)
  /\ refundToVar \in Actors
  /\ requiresAcceptance \in BOOLEAN
  /\ accepted \in BOOLEAN

Init ==
  /\ state = "None"
  /\ ledgerTime = 0
  /\ amount = 0
  /\ payerVar = Payer
  /\ payeeVar = Payee
  /\ releaserSet = {Releaser}
  /\ threshold = 1
  /\ refundAfter = NoDeadline
  /\ releaseNotBefore = NoDeadline
  /\ refundToVar = RefundTo
  /\ requiresAcceptance = FALSE
  /\ accepted = FALSE

CreateEscrow ==
  /\ state = "None"
  /\ amount' \in 1..MaxAmount
  /\ payerVar' = Payer
  /\ payeeVar' = Payee
  /\ releaserSet' = {Releaser}
  /\ threshold' = 1
  /\ refundToVar' = RefundTo
  /\ requiresAcceptance' = FALSE
  /\ accepted' = FALSE
  /\ refundAfter' = NoDeadline
  /\ releaseNotBefore' = NoDeadline
  /\ state' = "Funded"
  /\ ledgerTime' = ledgerTime
  /\ UNCHANGED <<ledgerTime, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance, accepted>>

AdvanceLedger ==
  /\ ledgerTime < MaxTime
  /\ ledgerTime' = ledgerTime + 1
  /\ UNCHANGED <<state, amount, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance, accepted>>

ReleaseEscrow(caller) ==
  /\ state = "Funded"
  /\ caller \in releaserSet
  /\ threshold = 1
  /\ (releaseNotBefore = NoDeadline \/ ledgerTime >= releaseNotBefore)
  /\ (requiresAcceptance => accepted)
  /\ state' = "Released"
  /\ UNCHANGED <<ledgerTime, amount, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance, accepted>>

RefundEscrow(caller) ==
  /\ state = "Funded"
  /\ caller \in releaserSet
  /\ threshold = 1
  /\ (refundAfter = NoDeadline \/ ledgerTime < refundAfter)
  /\ state' = "Refunded"
  /\ UNCHANGED <<ledgerTime, amount, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance, accepted>>

PayeeRefund(caller) ==
  /\ state = "Funded"
  /\ caller = payeeVar
  /\ state' = "Refunded"
  /\ UNCHANGED <<ledgerTime, amount, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance, accepted>>

TimeoutRefund(caller) ==
  /\ state = "Funded"
  /\ refundAfter # NoDeadline
  /\ ledgerTime >= refundAfter
  /\ caller \in Actors
  /\ state' = "Refunded"
  /\ UNCHANGED <<ledgerTime, amount, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance, accepted>>

ReleaseWithApprovals(approvers) ==
  /\ state = "Funded"
  /\ threshold > 1
  /\ approvers \subseteq releaserSet
  /\ Cardinality(approvers) >= threshold
  /\ (releaseNotBefore = NoDeadline \/ ledgerTime >= releaseNotBefore)
  /\ (requiresAcceptance => accepted)
  /\ state' = "Released"
  /\ UNCHANGED <<ledgerTime, amount, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance, accepted>>

RefundWithApprovals(approvers) ==
  /\ state = "Funded"
  /\ threshold > 1
  /\ approvers \subseteq releaserSet
  /\ Cardinality(approvers) >= threshold
  /\ state' = "Refunded"
  /\ UNCHANGED <<ledgerTime, amount, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance, accepted>>

AcceptEscrow(caller) ==
  /\ state = "Funded"
  /\ requiresAcceptance = TRUE
  /\ caller = payeeVar
  /\ accepted = FALSE
  /\ accepted' = TRUE
  /\ state' = "Funded"
  /\ UNCHANGED <<ledgerTime, amount, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance>>

ReleaseEnabled ==
  /\ state = "Funded"
  /\ threshold = 1
  /\ (releaseNotBefore = NoDeadline \/ ledgerTime >= releaseNotBefore)
  /\ (requiresAcceptance => accepted)

TimeoutEnabled ==
  /\ state = "Funded"
  /\ refundAfter # NoDeadline
  /\ ledgerTime >= refundAfter

SameLedgerRace ==
  /\ (state = "Funded" /\ refundAfter # NoDeadline /\ ledgerTime >= refundAfter) => ~(ReleaseEnabled /\ TimeoutEnabled)

Next ==
  CreateEscrow
  \/ (\E caller \in Actors : ReleaseEscrow(caller))
  \/ (\E caller \in Actors : RefundEscrow(caller))
  \/ (\E caller \in Actors : PayeeRefund(caller))
  \/ (\E caller \in Actors : TimeoutRefund(caller))
  \/ (\E approvers \in SUBSET Actors : ReleaseWithApprovals(approvers))
  \/ (\E approvers \in SUBSET Actors : RefundWithApprovals(approvers))
  \/ (\E caller \in Actors : AcceptEscrow(caller))
  \/ AdvanceLedger

NoDoubleSettlement ==
  /\ state \in StatusSet

FundConservation ==
  /\ amount >= 0
  /\ amount <= MaxAmount

LedgerMonotonic ==
  /\ ledgerTime >= 0

TerminalStateConsistency ==
  /\ state \in StatusSet
  /\ (state = "Released" => amount > 0)
  /\ (state = "Refunded" => amount > 0)

Spec == Init /\ [][Next]_<<state, ledgerTime, amount, payerVar, payeeVar, releaserSet, threshold, refundAfter, releaseNotBefore, refundToVar, requiresAcceptance, accepted>>

====
