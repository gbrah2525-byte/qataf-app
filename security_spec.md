# Security Specification & Payload-First TDD (Phase 0)

## 1. Data Invariants
1. **Identity Isolation**: Only the authenticated, email-verified user (`request.auth.uid == userId && request.auth.token.email_verified == true`) can read or write `/users/{userId}` or any subcollection (`taskCompletions`, `adLogs`, `withdrawals`).
2. **PII Isolation**: User email is stored only inside `/users/{userId}` and never exposed to blanket `isSignedIn()` reads or list queries.
3. **No Negative or Unbounded Points**: `points >= 0`, `totalEarnedPoints >= 0`, `totalWithdrawnUsdt >= 0`, `adsWatchedCount >= 0`, `tasksCompletedCount >= 0`. On creation, `points == 0` and `totalEarnedPoints == 0` (preventing self-minting on account creation).
4. **Master Gate**: Subcollection creates (`taskCompletions`, `adLogs`, `withdrawals`) require the parent `/users/{userId}` document to exist via `exists()`.
5. **Strict Ad Reward Invariant**: `adLogs` documents must enforce `durationSeconds >= 120` and `pointsAwarded == 50`.
6. **Immutability & Terminal State**: `uid`, `email`, and `createdAt` are immutable on `/users/{userId}`. Subcollection logs (`adLogs`, `taskCompletions`, `withdrawals` once `confirmed`) cannot be altered or deleted to replay rewards or conceal withdrawals.
7. **Temporal Integrity**: All `createdAt`, `updatedAt`, and `completedAt` fields must match `request.time`.

## 2. The "Dirty Dozen" Attack Payloads (All Must Fail with PERMISSION_DENIED)
1. **Unauthenticated Read**: `GET /users/victimUid` with `auth: null`.
2. **Cross-User Read (PII Leak)**: `GET /users/victimUid` authenticated as `attackerUid`.
3. **Unverified Email Write**: `CREATE /users/attackerUid` with `email_verified: false`.
4. **Self-Minted Initial Points**: `CREATE /users/attackerUid` with `points: 999999`.
5. **Shadow / Ghost Field Injection**: `UPDATE /users/attackerUid` adding `isAdmin: true` or `vipBypass: true`.
6. **Negative Points / Integer Underflow**: `UPDATE /users/attackerUid` setting `points: -500`.
7. **Fake Timestamp Spoofing**: `CREATE /users/attackerUid` with `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time`.
8. **ID Poisoning (1.5KB Document ID)**: `CREATE /users/attackerUid/adLogs/<1500_char_string>`.
9. **Ad Duration / Reward Tampering**: `CREATE /users/attackerUid/adLogs/log1` with `durationSeconds: 5, pointsAwarded: 5000`.
10. **Orphaned Subcollection Write**: `CREATE /users/ghostUid/withdrawals/w1` when `/users/ghostUid` does not exist.
11. **Terminal Withdrawal Tampering**: `UPDATE /users/attackerUid/withdrawals/w1` changing `status` or `amountUsdt` after `confirmed`.
12. **Blanket User List Scraping**: `LIST /users` authenticated as any user.
