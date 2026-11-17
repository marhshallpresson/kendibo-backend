# Kendibo — Production Backend & Platform Architecture Blueprint

This is the backend architecture I would put in front of a senior engineering team before they write production code.

The supplied architecture already makes the correct foundational choice: **NestJS + PostgreSQL/PostGIS + Redis + BullMQ + object storage + adapter-based third parties**, implemented initially as a modular monolith rather than premature microservices. It also correctly treats the **job state machine and financial ledger as the two highest-integrity components**. 

The mobile application should remain a client of this backend. The React Native/Expo application you specified — Expo SDK 57, Expo Router, React Query, Zustand, offline persistence, kobo-based money handling and Nigerian address semantics — should **not contain business authority**. The server remains authoritative for price, availability, booking state, payment state, provider assignment and permissions.

---

# 1. What Kendibo actually is technically

Kendibo is not simply a booking application.

It is a combination of:

```text
Marketplace
+
Field Service Management System
+
Dispatch Engine
+
Payment / Ledger System
+
Property Management System
+
Provider Management System
+
Customer CRM
+
Real-time Tracking System
+
Operations Control Tower
+
B2B Work-order Platform
```

That distinction changes the backend architecture considerably.

The central object should be the **Job**.

Everything ultimately revolves around:

```text
Customer
   ↓
Property
   ↓
Service Request
   ↓
Booking / Job
   ↓
Pricing
   ↓
Payment
   ↓
Dispatch
   ↓
Provider
   ↓
Execution
   ↓
Evidence
   ↓
Completion
   ↓
Settlement
   ↓
Warranty / Review / History
```

And underneath the financial side:

```text
Payment
   ↓
Ledger
   ↓
Hold
   ↓
Settlement
   ↓
Provider Payable
   ↓
Payout
```

The supplied plan already defines this correctly: Kendibo is fundamentally a **three-sided operations platform with a money ledger and job state machine at its core**. 

---

# 2. Recommended production stack

## Core backend

| Layer               | Recommendation                                |
| ------------------- | --------------------------------------------- |
| Language            | TypeScript                                    |
| Runtime             | Node.js 22 LTS                                |
| Framework           | NestJS                                        |
| HTTP                | Fastify                                       |
| API                 | REST `/v1`                                    |
| API documentation   | OpenAPI 3.1                                   |
| Validation          | Zod or class-validator                        |
| ORM/query           | Knex + SQL                          |
| Database            | PostgreSQL 16+                                |
| Geospatial          | PostGIS                                       |
| Cache               | Redis                                         |
| Jobs                | BullMQ                                        |
| Realtime            | Socket.IO                                     |
| Object storage      | S3                                            |
| CDN                 | CloudFront                                    |
| Authentication      | JWT + rotating refresh tokens                 |
| OTP                 | SMS provider                                  |
| Payments            | Paga adapter                |
| KYC                 | KycPort adapter                               |
| Maps                | MapsPort adapter                              |
| Push                | Firebase Cloud Messaging                      |
| Email               | Resend/SES                                    |
| WhatsApp            | WhatsApp Business provider                    |
| Monitoring          | WatchUp                                       |
| Logs                | Pino JSON                                     |
| Tracing             | OpenTelemetry                                 |
| Infrastructure      | AWS                                           |
| Containers          | Docker                                        |
| Compute             | ECS Fargate                                   |
| IaC                 | Terraform                                     |
| CI/CD               | GitHub Actions                                |
| Secrets             | AWS Secrets Manager                           |
| Encryption          | AWS KMS                                       |
| Testing             | Vitest/Jest + Supertest + Testcontainers      |
| E2E                 | Playwright/Maestro/Detox depending on client  |
| Load testing        | k6                                            |
| Dependency security | Dependabot/Renovate + SAST/container scanning |

The architecture should remain a **modular monolith with three deployables**:

```text
Kendibo Backend
│
├── API
├── Worker
└── Realtime
```

rather than starting with 15 microservices. The supplied architecture explicitly recommends this because Kendibo's early scale does not justify distributed transactions around money and job state. 

---

# 3. The actual backend topology

```text
                         ┌──────────────────────┐
                         │   Kendibo Mobile     │
                         │ Customer / Provider  │
                         └──────────┬───────────┘
                                    │
                         HTTPS / WebSocket
                                    │
                         ┌──────────▼───────────┐
                         │ CloudFront + WAF      │
                         └──────────┬───────────┘
                                    │
                              Application LB
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
       ┌──────▼──────┐      ┌──────▼──────┐      ┌──────▼──────┐
       │ API Cluster │      │ Realtime    │      │ Worker      │
       │ NestJS      │      │ Socket.IO   │      │ BullMQ      │
       └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
              │                    │                    │
              └────────────────────┼────────────────────┘
                                   │
                 ┌─────────────────┴─────────────────┐
                 │                                   │
          ┌──────▼──────┐                     ┌──────▼──────┐
          │ PostgreSQL  │                     │ Redis       │
          │ + PostGIS   │                     │             │
          └──────┬──────┘                     └─────────────┘
                 │
        ┌────────┴────────┐
        │                 │
    S3 Storage       Read Replica
```

External integrations:

```text
                    Kendibo
                       │
       ┌───────────────┼────────────────┐
       │               │                │
    Payments          KYC             Maps
       │               │                │
 Paga            Dojah/etc       Google/Mapbox
       │
       ├── SMS
       ├── WhatsApp
       ├── Email
       ├── Push
       ├── Telephony
       └── WatchUp
```

Every external provider gets an **adapter interface**.

Do not allow:

```ts
booking.service.ts
```

to directly import:

```ts
Paga sdk
```

Instead:

```ts
PaymentPort
   ↑
   ├── PagaAdapter
   └── FlutterwaveAdapter
```

That gives Kendibo provider independence.

---

# 4. Backend domain modules

I would structure the backend as:

```text
apps/
├── api/
├── worker/
└── realtime/

packages/
├── config/
├── contracts/
├── database/
├── observability/
└── shared/

modules/
├── identity/
├── users/
├── organizations/
├── authorization/
├── devices/
├── properties/
├── addresses/
├── catalog/
├── pricing/
├── promotions/
├── quotes/
├── bookings/
├── job-engine/
├── providers/
├── provider-skills/
├── availability/
├── dispatch/
├── geo/
├── tracking/
├── payments/
├── ledger/
├── payouts/
├── refunds/
├── disputes/
├── warranties/
├── reviews/
├── messaging/
├── notifications/
├── media/
├── support/
├── fraud/
├── kyc/
├── b2b/
├── configuration/
├── feature-flags/
├── analytics/
├── cms/
├── search/
├── audit/
└── privacy/
```

The important rule:

> **A module owns its data and exposes services/events — another module must not reach into its tables.**

The supplied plan specifically recommends separate PostgreSQL schemas and boundary enforcement in CI. 

---

# 5. Identity architecture

Kendibo needs more than "login".

## Authentication

Support:

```text
Phone OTP
Email OTP
Refresh tokens
Device sessions
PIN
Biometrics on device
Admin 2FA
```

Flow:

```text
Phone
 ↓
POST /auth/otp/request
 ↓
SMS
 ↓
POST /auth/otp/verify
 ↓
Access Token
Refresh Token
 ↓
Device Registration
```

### Token architecture

Access:

```text
JWT
15-minute lifetime
```

Refresh:

```text
30–60 day lifetime
rotating
hashed in database
device-bound
reuse detection
```

Never store raw refresh tokens.

---

# 6. User / role architecture

Roles should be permission-based.

```text
CUSTOMER

PROVIDER

PROVIDER_ADMIN

DISPATCHER

OPERATIONS

CUSTOMER_SUPPORT

FINANCE

TRUST_SAFETY

CONTENT_MANAGER

PROPERTY_MANAGER

B2B_ADMIN

B2B_MEMBER

SUPER_ADMIN
```

Permission example:

```text
booking:create
booking:view:self
booking:view:any
booking:cancel
booking:override
provider:verify
provider:suspend
payment:view
payment:refund
ledger:view
payout:approve
pricing:publish
configuration:edit
audit:view
```

Never write:

```ts
if (user.role === 'admin')
```

everywhere.

Use:

```ts
authorize('pricing.publish')
```

---

# 7. Property architecture

This is one of the things that differentiates Kendibo from a generic service marketplace.

Structure:

```text
User
 └── Property
      ├── Address
      ├── Rooms
      ├── Assets
      │    ├── AC
      │    ├── Generator
      │    ├── Refrigerator
      │    ├── Washing Machine
      │    └── etc.
      ├── Service History
      ├── Warranty Records
      ├── Documents
      └── Maintenance Plans
```

Example:

```text
Property:
Kendibo Residence

Address:
House 14
Gwarinpa
Abuja
Landmark: Near XYZ Junction
Estate: ABC Estate
Gate instructions: Call security
```

Then:

```text
Asset:
Samsung AC

Installed:
2026-04-10

Last serviced:
2026-09-20

Next service:
2026-12-20

Warranty:
Active
```

This enables the eventual:

> **Property Maintenance OS**

rather than simply a booking marketplace.

---

# 8. Catalog engine

Do not hard-code services.

Database-driven catalog:

```text
Category
 └── Service
      ├── Package
      ├── Add-on
      ├── Duration
      ├── Requirements
      ├── Eligibility
      ├── Pricing Rule
      ├── Warranty Policy
      ├── Checklist
      └── Media
```

Example:

```text
AC Services
 ├── AC General Service
 ├── AC Deep Cleaning
 ├── AC Installation
 ├── AC Gas Refill
 └── AC Diagnosis
```

Each service can specify:

```json
{
  "bookingMode": "fixed",
  "requiresInspection": false,
  "requiresProviderSkill": true,
  "warrantyDays": 7,
  "durationMinutes": 90
}
```

For complex work:

```json
{
  "bookingMode": "quote",
  "requiresInspection": true
}
```

---

# 9. Pricing engine

This deserves its own module.

Never calculate final price in React Native.

The client may display an estimate.

The backend calculates the authoritative amount.

```text
price(context)
        ↓
Base price
+ Add-ons
+ Quantity
+ Distance
+ Urgency
+ Weekend
+ Holiday
+ Platform fee
- Discount
+ VAT
        ↓
TOTAL
```

All money:

```ts
bigint
```

and:

```text
NGN 25,000
=
2,500,000 kobo
```

No floating-point financial calculations.

The supplied backend plan explicitly requires integer kobo and versioned price rules frozen into the booking snapshot. 

---

# 10. Booking engine

The booking engine is the heart of the platform.

## Fixed-price

```text
Service
 ↓
Add-ons
 ↓
Address
 ↓
Date
 ↓
Time
 ↓
Price
 ↓
Payment
 ↓
Booking
 ↓
Matching
```

## Quote-based

```text
Problem
 ↓
Photos/video
 ↓
Inspection request
 ↓
Provider/technician
 ↓
Inspection
 ↓
Quote
 ↓
Customer approval
 ↓
Payment authorization
 ↓
Work
```

---

# 11. The 19-stage job state machine

The frontend contract already specifies:

```text
DRAFT
REQUESTED
PAYMENT_PENDING
CONFIRMED
MATCHING
PROVIDER_ASSIGNED
PROVIDER_ACCEPTED
EN_ROUTE
ARRIVED
CHECK_IN
INSPECTION
IN_PROGRESS
AWAITING_APPROVAL
COMPLETED
CUSTOMER_CONFIRMATION
SETTLEMENT
WARRANTY_ACTIVE
CLOSED
CANCELLED
```

These should **not** be simple strings manipulated throughout the application.

Create:

```text
JobCommand
JobTransition
JobEvent
JobGuard
```

Example:

```text
Provider:
EN_ROUTE
    ↓
ARRIVED
```

Guard:

```text
provider owns assignment
AND
location is sufficiently close
AND
job is still active
```

The supplied architecture correctly specifies transactional locking, transition guards, append-only job events and an outbox for every state transition. 

---

# 12. Event-driven backend

Internally:

```text
BookingCreated
PaymentSucceeded
ProviderMatched
ProviderAccepted
ProviderArrived
JobStarted
QuoteCreated
QuoteAccepted
JobCompleted
CustomerConfirmed
WarrantyOpened
DisputeCreated
RefundApproved
PayoutCreated
```

These events feed:

```text
Notifications
Analytics
Fraud
Ledger
Dispatch
Support
Search
CRM
```

Use the **Transactional Outbox Pattern**.

```text
DB Transaction
     │
     ├── update job
     ├── insert job_event
     └── insert outbox_event
             │
             ↓
          Worker
             │
     ┌───────┼────────┐
     ↓       ↓        ↓
 Notify   Analytics  Ledger
```

Never:

```ts
await database.save()
await sendSMS()
await chargePayment()
```

inside one HTTP request and assume all three succeed.

---

# 13. API architecture

Base:

```text
https://api.kendibo.com/v1
```

All APIs should have:

```text
request_id
idempotency_key
cursor pagination
structured errors
API version
rate limits
```

Error format:

```json
{
  "error": {
    "code": "BOOKING_NOT_SERVICEABLE",
    "message": "This service is not available in your area.",
    "requestId": "req_01...",
    "retryable": false
  }
}
```

---

# 14. Complete API surface

## Authentication

```http
POST /auth/otp/request
POST /auth/otp/verify
POST /auth/email/request
POST /auth/email/verify
POST /auth/refresh
POST /auth/logout
POST /auth/logout-all
POST /auth/pin/create
POST /auth/pin/verify
POST /auth/pin/change
POST /auth/biometrics/enable
```

---

## User

```http
GET    /me
PATCH  /me
DELETE /me
GET    /me/sessions
DELETE /me/sessions/:id
POST   /devices
DELETE /devices/:id
GET    /config
```

---

# 15. Address APIs

```http
GET    /addresses
POST   /addresses
GET    /addresses/:id
PATCH  /addresses/:id
DELETE /addresses/:id
POST   /addresses/:id/default
GET    /geo/zones/check
GET    /geo/geocode
GET    /geo/reverse-geocode
```

Address payload should preserve Nigerian context:

```json
{
  "houseNumber": "14",
  "street": "Example Street",
  "estate": "Example Estate",
  "landmark": "Near XYZ Junction",
  "gateInstructions": "Call security",
  "contactPhone": "+234...",
  "latitude": 9.0,
  "longitude": 7.4
}
```

---

# 16. Property APIs

```http
GET    /properties
POST   /properties
GET    /properties/:id
PATCH  /properties/:id
DELETE /properties/:id

GET    /properties/:id/assets
POST   /properties/:id/assets
PATCH  /properties/:id/assets/:assetId
DELETE /properties/:id/assets/:assetId

GET    /properties/:id/service-history
GET    /properties/:id/warranties
GET    /properties/:id/maintenance
POST   /properties/:id/maintenance-plans
```

---

# 17. Catalog APIs

```http
GET /categories
GET /categories/:id
GET /services
GET /services/:id
GET /services/:id/add-ons
GET /services/:id/packages
GET /services/:id/reviews
GET /services/:id/availability
```

Search:

```http
GET /search/services?q=ac
```

---

# 18. Booking APIs

```http
POST /bookings
GET  /bookings
GET  /bookings/:id
PATCH /bookings/:id
POST /bookings/:id/cancel
POST /bookings/:id/reschedule
POST /bookings/:id/confirm
GET  /bookings/:id/events
GET  /bookings/:id/timeline
```

Creation requires:

```http
Idempotency-Key: ...
```

This prevents:

```text
double tap
network retry
app retry
proxy retry
```

from producing duplicate bookings.

---

# 19. Quote APIs

```http
POST /quotes
GET /quotes/:id
GET /quotes/:id/revisions
POST /quotes/:id/accept
POST /quotes/:id/reject

POST /change-orders
GET  /change-orders/:id
POST /change-orders/:id/approve
POST /change-orders/:id/reject
```

Quote revisions should be immutable.

```text
Quote v1
 ↓
Quote v2
 ↓
Quote v3
 ↓
Customer accepts v3
```

Never overwrite v1.

---

# 20. Provider APIs

```http
POST /provider/onboarding
GET  /provider/profile
PATCH /provider/profile

POST /provider/kyc
GET  /provider/kyc/status

GET  /provider/skills
POST /provider/skills
DELETE /provider/skills/:id

GET /provider/availability
POST /provider/availability

POST /provider/online
POST /provider/offline

GET /provider/offers
POST /provider/offers/:id/accept
POST /provider/offers/:id/decline

GET /provider/jobs
GET /provider/jobs/:id
```

---

# 21. Provider execution APIs

```http
POST /jobs/:id/arrive
POST /jobs/:id/check-in
POST /jobs/:id/start
POST /jobs/:id/inspection
POST /jobs/:id/request-approval
POST /jobs/:id/complete
POST /jobs/:id/evidence
```

Every command must be:

```text
authenticated
authorized
idempotent
state-validated
audited
```

---

# 22. Dispatch APIs

Most dispatch operations should be internal rather than public:

```text
findCandidates(job)
scoreCandidates(job)
createOffer(job, provider)
expireOffer(assignment)
assignProvider(job, provider)
reassign(job)
escalate(job)
```

Admin APIs:

```http
GET  /admin/dispatch/live
GET  /admin/dispatch/jobs/unassigned
GET  /admin/dispatch/providers
POST /admin/dispatch/jobs/:id/assign
POST /admin/dispatch/jobs/:id/reassign
```

The supplied design uses **hard eligibility filters first**, followed by configurable scoring based on distance, availability, skill, experience, rating, completion reliability, response rate, workload and fairness. 

---

# 23. Location APIs

Provider:

```http
POST /provider/location
POST /provider/location/batch
```

Customer:

```http
GET /bookings/:id/provider-location
GET /bookings/:id/eta
```

Location should only be exposed during an active service journey.

```text
EN_ROUTE
    ↓
ARRIVED
    ↓
IN_PROGRESS
    ↓
location access closes
```

Do not create a permanent customer-facing provider location feed.

---

# 24. Realtime architecture

Socket namespace:

```text
/ws
```

Rooms:

```text
user:{userId}
job:{jobId}
provider:{providerId}
ops:dispatch
```

Events:

```text
booking.updated
provider.assigned
provider.location
provider.arrived
job.started
job.completed
quote.created
quote.updated
message.created
payment.updated
```

Server must authorize room membership.

A user should never be able to:

```text
join job:someone-elses-job
```

The supplied architecture explicitly requires authorization when joining job rooms and polling fallback when sockets fail. 

---

# 25. Messaging

Database:

```text
conversation
conversation_participant
message
message_attachment
message_delivery
```

API:

```http
GET  /jobs/:id/messages
POST /jobs/:id/messages
POST /messages/:id/read
```

Realtime:

```text
message.created
message.delivered
message.read
```

Initially:

```text
Customer ↔ Provider
```

Later:

```text
Customer ↔ Support
Provider ↔ Support
B2B ↔ Operations
```

Phone numbers should not need to be exposed to either party.

---

# 26. Payments

Payment architecture:

```text
PaymentPort
│
├── PagaAdapter
└── FlutterwaveAdapter
```

Endpoints:

```http
POST /bookings/:id/payments
GET  /payments/:id
POST /payments/:id/verify
POST /payments/:id/cancel
POST /payments/:id/refund
```

Webhook:

```http
POST /webhooks/payments/paga
POST /webhooks/payments/flutterwave
```

Critical rule:

> **Webhook ≠ payment truth until verified.**

The supplied design correctly requires signature validation, persistence of raw events, asynchronous processing and server-side verification before crediting the ledger. 

---

# 27. The ledger

This is where I would be extremely conservative.

Do not make:

```text
payment.total
```

the financial system.

Create:

```text
ledger_account
ledger_journal
ledger_entry
ledger_balance
```

Example:

```text
Customer pays ₦10,000

DR PSP Receivable       ₦10,000
CR Customer Funds Held  ₦10,000
```

After completion:

```text
DR Customer Funds Held  ₦10,000

CR Provider Payable      ₦7,000
CR Platform Revenue      ₦3,000
```

Provider payout:

```text
DR Provider Payable      ₦7,000
CR Payout In Flight      ₦7,000
```

Then:

```text
DR Payout In Flight      ₦7,000
CR PSP Receivable        ₦7,000
```

Every journal:

```text
Debit == Credit
```

always.

The supplied plan explicitly specifies append-only journals, idempotent posting, reversing corrections rather than mutation, and nightly balance reconstruction. 

---

# 28. Refund engine

Refund should not be:

```ts
payment.refund()
```

It should be a policy decision.

```text
RefundPolicy
 ├── cancellation timing
 ├── provider fault
 ├── customer fault
 ├── emergency
 ├── service failure
 ├── dispute
 └── warranty
```

Then:

```text
RefundRequested
 ↓
PolicyEvaluation
 ↓
RefundApproved / ManualReview
 ↓
PSP Refund
 ↓
Ledger Reversal
 ↓
Refunded
```

---

# 29. Provider payout engine

```text
Provider earnings
       ↓
Pending
       ↓
Eligible
       ↓
Held
       ↓
Payout Run
       ↓
Finance Approval
       ↓
PSP Transfer
       ↓
Success / Failed / Reversed
```

Bank account changes:

```text
change requested
 ↓
KYC name match
 ↓
cooling period
 ↓
fraud check
 ↓
eligible
```

The supplied architecture already recommends maker-checker payout approval and a cooling period after bank-account changes. 

---

# 30. KYC architecture

Use:

```text
KycPort
```

with interchangeable adapters:

```text
Dojah
Smile ID
Prembly
```

Flow:

```text
Provider registration
 ↓
Identity information
 ↓
ID verification
 ↓
NIN/BVN where applicable
 ↓
Selfie/liveness
 ↓
Face match
 ↓
CAC verification for businesses
 ↓
Bank account verification
 ↓
Manual review if ambiguous
 ↓
VERIFIED
```

The backend plan explicitly recommends this adapter architecture rather than coupling Kendibo to one KYC vendor. 

---

# 31. Fraud engine

This should be a real domain, not an afterthought.

Signals:

```text
multiple accounts
same device
same phone
same bank account
impossible travel
GPS spoofing
repeated refunds
promo abuse
fake completion evidence
duplicate photographs
provider/customer collusion
abnormal cancellation patterns
sudden bank-account changes
```

Actions:

```text
FLAG
REVIEW
HOLD_PAYOUT
REQUIRE_VERIFICATION
RESTRICT
SUSPEND
```

---

# 32. Media pipeline

Do not allow clients to upload arbitrary files directly into a permanent public bucket.

Correct flow:

```text
Mobile
 ↓
POST /media/presign
 ↓
S3 presigned URL
 ↓
Upload
 ↓
Quarantine bucket
 ↓
Virus scan
 ↓
Magic-byte validation
 ↓
EXIF handling
 ↓
SHA-256 hash
 ↓
Thumbnail generation
 ↓
Clean bucket
 ↓
Signed URL
```

The supplied plan specifies this quarantine/scan/hash pipeline, including EXIF handling and signed URLs. 

---

# 33. Notification engine

One event:

```text
ProviderAssigned
```

should not contain:

```ts
sendSms()
sendPush()
sendWhatsapp()
```

Instead:

```text
Domain Event
 ↓
Notification Template
 ↓
Channel Router
 ↓
Push
 ↓
SMS fallback
 ↓
WhatsApp fallback
```

Templates:

```text
booking.confirmed
provider.assigned
provider.en_route
provider.arrived
quote.ready
payment.success
payment.failed
refund.completed
warranty.expiring
```

All templates versioned.

---

# 34. Offline-first provider architecture

This is especially important for Nigeria.

Provider devices may have:

```text
poor network
intermittent network
background restrictions
low-end Android hardware
GPS instability
```

Provider application should maintain:

```text
local command queue
```

Example:

```json
{
  "clientEventId": "uuid",
  "command": "ARRIVE",
  "jobId": "uuid",
  "clientTs": "...",
  "payload": {}
}
```

Then:

```http
POST /provider/sync
```

returns:

```json
{
  "results": [
    {
      "clientEventId": "...",
      "status": "applied"
    },
    {
      "clientEventId": "...",
      "status": "duplicate"
    },
    {
      "clientEventId": "...",
      "status": "rejected",
      "reason": "JOB_ALREADY_COMPLETED"
    }
  ]
}
```

The supplied plan specifically calls for idempotent offline commands and server reconciliation. 

---

# 35. B2B backend

B2B should not be bolted onto customer accounts.

Introduce:

```text
Organization
OrganizationMember
OrganizationRole
PropertyPortfolio
WorkOrder
ServiceAgreement
Invoice
PurchaseOrder
Approval
```

Flow:

```text
Organization
 ↓
Properties
 ↓
Maintenance Request
 ↓
Work Order
 ↓
Approval
 ↓
Dispatch
 ↓
Provider
 ↓
Completion
 ↓
Invoice
 ↓
Settlement
```

Roles:

```text
B2B_OWNER
FACILITY_MANAGER
PROPERTY_MANAGER
APPROVER
STAFF
FINANCE
```

Use Postgres RLS as a second authorization boundary for organization data.

---

# 36. Admin/Ops control plane

The admin backend needs substantially more than CRUD.

## Operations dashboard

```text
Live Jobs
Unassigned Jobs
Provider Map
Late Jobs
Failed Payments
Pending Quotes
Disputes
Refunds
KYC Queue
Provider Incidents
```

## Finance

```text
Transactions
Ledger
Refunds
Payouts
Reconciliation
PSP settlements
Revenue
Fees
```

## Trust & Safety

```text
KYC
Fraud
Suspensions
Reports
Evidence
Disputes
```

## Configuration

```text
Cities
Zones
Services
Prices
Taxes
Fees
Dispatch policies
Cancellation policies
Warranty policies
Feature flags
Notification templates
```

---

# 37. Configuration architecture

This is critical for expansion.

Do not deploy code to change:

```text
Abuja service radius
VAT
AC pricing
provider radius
cancellation fee
```

Store them as versioned configuration.

```text
city
zone
service
price_book
price_rule
fee_rule
tax_rule
dispatch_policy
refund_policy
warranty_policy
feature_flag
```

Then:

```text
Abuja
 ├── Zone A
 ├── Zone B
 └── Zone C

Lagos
 ├── Zone A
 ├── Zone B
 └── Zone C
```

The supplied architecture explicitly calls for cities, zones, prices, weights and policies to be stored as versioned data. 

---

# 38. Database architecture

Core schemas:

```text
identity
user
organization
property
catalog
pricing
booking
dispatch
provider
geo
payment
ledger
payout
quote
notification
messaging
media
support
fraud
audit
configuration
analytics
b2b
```

Use:

```text
UUIDv7
```

for primary IDs.

Use:

```text
timestamptz
```

everywhere.

Store timestamps:

```text
UTC
```

Display:

```text
WAT / UTC+1
```

to Nigerian users.

---

# 39. Critical database constraints

Do not rely solely on application code.

Examples:

```sql
UNIQUE(payment.reference)
```

```sql
UNIQUE(job_id, client_event_id)
```

```sql
UNIQUE(job_id)
WHERE assignment.status = 'accepted'
```

```sql
CHECK(amount_kobo > 0)
```

```sql
CHECK(currency = 'NGN')
```

The database should make impossible states physically difficult to create.

---

# 40. Redis responsibilities

Redis should handle:

```text
queues
locks
rate limits
provider GEO
short-lived sessions
OTP
feature flag cache
pub/sub
temporary state
```

Do not use Redis as the permanent source of truth.

For example:

```text
Redis says:
provider is online
```

but PostgreSQL remains the authoritative record for:

```text
provider
assignment
booking
financial state
```

The supplied plan specifically recommends separate Redis capacity for queues versus cache so cache eviction cannot destroy jobs. 

---

# 41. Background workers

Queues:

```text
critical
payments
dispatch
notifications
media
analytics
maintenance
exports
bulk
```

Jobs:

```text
payment.reconcile
payment.refund
payout.execute
assignment.expire
quote.expire
job.auto-confirm
warranty.expire
notification.send
media.process
provider.location.aggregate
analytics.export
privacy.delete
privacy.export
```

Every worker job needs:

```text
idempotency
retry policy
exponential backoff
dead-letter queue
metrics
trace ID
```

---

# 42. API security

Implement:

```text
WAF
rate limiting
JWT
refresh rotation
RBAC
ownership checks
RLS for B2B
CSRF protection where cookie auth exists
CORS allowlist
request size limits
file type validation
SQL injection protection
SSRF protection
webhook signatures
OTP throttling
device fingerprint signals
```

Particularly:

### IDOR tests

Try:

```http
GET /bookings/another-user-booking
```

and:

```http
GET /properties/another-company-property
```

Every endpoint must enforce ownership.

---

# 43. Privacy architecture

Because Kendibo handles:

```text
identity documents
location
phone numbers
bank information
property information
payment information
photos
```

PII should be classified.

Example:

```text
PUBLIC
INTERNAL
CONFIDENTIAL
PII
SENSITIVE_PII
FINANCIAL
```

Then enforce:

```text
encryption
access policy
retention
masking
audit
deletion
export
```

The supplied plan correctly identifies the Nigeria Data Protection Act 2023 and GAID 2025 as the current compliance baseline rather than the older NDPR reference found on the Musskart page. 

---

# 44. Observability — integrate WatchUp here

This is where the WatchUp integration belongs.

WatchUp positions itself as an application observability platform covering error tracking, API tracing, database monitoring, server metrics and alerting, including WhatsApp/Telegram/Slack/email channels. ([watchup.site][1])

For Kendibo, I would use it as the **application-level operational observability layer**, while retaining structured logs and infrastructure-native monitoring.

Architecture:

```text
                 Kendibo
                    │
        ┌───────────┼────────────┐
        │           │            │
      Errors      Traces       Events
        │           │            │
        └───────────┼────────────┘
                    │
                 WatchUp
                    │
       ┌────────────┼────────────┐
       ↓            ↓            ↓
    Dashboard    Alerts       Diagnosis
                    │
             WhatsApp / Slack
```

WatchUp's public material specifically describes Node.js middleware/request tracing and an ingest API, while its Python SDK documents error capture, custom events, user context, release/environment tagging and sampling. ([watchup.site][1])

---

# 45. WatchUp integration architecture

Create:

```text
src/infrastructure/observability/watchup/
```

with:

```text
watchup.client.ts
watchup.interceptor.ts
watchup.exception-filter.ts
watchup.context.ts
watchup.events.ts
```

Never scatter WatchUp calls throughout business logic.

Instead:

```ts
ObservabilityPort
```

with:

```ts
captureException()
captureMessage()
track()
setContext()
```

and:

```text
WatchupObservabilityAdapter
```

---

# 46. What Kendibo should send to WatchUp

### Automatic errors

```text
Unhandled exceptions
500 responses
Worker failures
Unhandled promise rejections
Realtime errors
Payment adapter failures
KYC adapter failures
Maps failures
Notification failures
```

### API tracing

Track:

```text
HTTP method
route
status
duration
service
environment
release
request_id
```

Do **not** send:

```text
OTP
authorization headers
refresh tokens
payment secrets
full request bodies
KYC documents
bank account details
```

WatchUp's Python SDK documentation says request tracing excludes authorization headers, cookies, query strings and request bodies, which is the right privacy posture to preserve in the Node implementation. ([PyPI][2])

---

# 47. Kendibo custom WatchUp events

This is where it becomes especially useful.

Track business-critical events:

```text
booking.created
booking.payment_failed
booking.payment_succeeded
booking.unassigned
booking.assigned
booking.provider_timeout
booking.cancelled
booking.completed

quote.created
quote.accepted
quote.rejected

provider.kyc_failed
provider.suspended

payout.failed
payout.reversed

refund.failed

dispatch.no_provider

webhook.failed
webhook.replayed

queue.dead_letter
```

WatchUp's published material specifically describes custom events such as `delivery_confirmed`, `payment_received` and `driver_assigned` as useful for correlating business failures with technical incidents. ([watchup.site][1])

For Kendibo:

```text
technical:
POST /v1/bookings
500 errors

business:
booking.created
booking.payment_failed
booking.unassigned
```

can be correlated.

---

# 48. WatchUp alert rules

I would configure at minimum:

### P0

```text
API error rate > 5%
Payment webhook processing stalled
Ledger imbalance detected
Database unavailable
Production API unavailable
```

### P1

```text
p95 booking creation > 1s
payment failure rate spikes
provider assignment SLA breach
queue age > threshold
worker crash rate increases
```

### P2

```text
slow endpoints
increased maps errors
SMS failures
notification failures
increased DB query latency
```

WatchUp's own guidance highlights error-rate, p99 latency, event-count drops and server CPU as useful alert conditions. ([watchup.site][3])

---

# 49. Do not make WatchUp the only monitoring system

Important architectural distinction:

```text
WatchUp
=
application observability
```

not:

```text
entire disaster-recovery strategy
```

Keep:

```text
CloudWatch
AWS alarms
OpenTelemetry
structured logs
database metrics
load balancer metrics
WatchUp
```

WatchUp can be the primary developer-facing incident surface, particularly because its alert channels include WhatsApp, but AWS should still provide infrastructure-level signals.

---

# 50. WatchUp CLI / deployment integration

For the supplied:

`https://watchup.site/docs/setup-cli`

the correct place in the DevOps pipeline is:

```text
Developer
   ↓
Git push
   ↓
GitHub Actions
   ↓
Test
   ↓
Build
   ↓
Deploy staging
   ↓
Smoke tests
   ↓
WatchUp verification
   ↓
Production approval
   ↓
Deploy
```

I would **not hard-code an exact CLI command from the URL without verifying the current CLI syntax**, because the documentation endpoint itself was not retrievable through the current web cache.

The public WatchUp material does establish the broader setup model: create a project, generate an API key, send telemetry through its API/SDK, and configure alert channels. ([watchup.site][1])

So engineering should create:

```text
WATCHUP_API_KEY
WATCHUP_PROJECT_ID
WATCHUP_ENV
WATCHUP_RELEASE
```

through AWS Secrets Manager/GitHub Actions secrets, never `.env` committed to Git.

---

# 51. Release tagging

Every Kendibo deployment should identify itself:

```text
environment=production
release=git-sha
service=api
region=af-south-1
```

Example:

```text
kendibo-api
release:
2026.10.06-a8f32d1
```

Then when:

```text
booking creation
```

starts failing after a deployment, WatchUp should allow the team to associate errors/traces with that release.

---

# 52. API health model

Create:

```http
GET /health/live
GET /health/ready
GET /health/dependencies
```

### `/live`

Only answers:

```text
process alive
```

### `/ready`

Checks:

```text
database
redis
critical configuration
```

### `/dependencies`

Reports:

```text
Postgres
Redis
Paga
Maps
KYC
SMS
Storage
```

Do not make `/health` depend on every third party or ECS will continuously kill a healthy API because Google Maps temporarily failed.

---

# 53. Deployment architecture

Production:

```text
                    Route53
                       │
                   CloudFront
                       │
                      WAF
                       │
                      ALB
                       │
        ┌──────────────┼───────────────┐
        ↓              ↓               ↓
     API Task       API Task        API Task
        │              │               │
        └──────────────┼───────────────┘
                       │
                 RDS PostgreSQL
                       │
                  Read Replica

Redis
│
├── Queue
├── Cache
├── GEO
└── Pub/Sub
```

Worker:

```text
Worker 1
Worker 2
```

Realtime:

```text
Realtime 1
Realtime 2
```

AWS ECS Fargate is appropriate here because the supplied architecture prioritizes managed operations over Kubernetes complexity for the MVP. 

---

# 54. CI/CD

Every PR:

```text
lint
↓
typecheck
↓
unit tests
↓
integration tests
↓
migration test
↓
OpenAPI diff
↓
SAST
↓
dependency scan
↓
container scan
↓
build
```

Merge:

```text
Deploy staging
 ↓
Smoke
 ↓
E2E
 ↓
Load sanity
 ↓
Manual approval
 ↓
Production
```

Production:

```text
Canary / rolling deployment
 ↓
Health checks
 ↓
WatchUp error-rate monitoring
 ↓
Automatic rollback trigger
```

The supplied plan already specifies OpenAPI diffing, security scanning, staging deployment, E2E verification and rolling rollback. 

---

# 55. Database migration discipline

Never:

```text
DROP COLUMN
```

in the same release that stops using it.

Use:

```text
Expand
 ↓
Backfill
 ↓
Switch
 ↓
Observe
 ↓
Contract
```

Example:

```text
Release 1:
add new column

Release 2:
write both

Release 3:
read new

Release 4:
stop old writes

Release 5:
remove old column
```

This makes rollback possible.

---

# 56. Testing architecture

You need much more than controller unit tests.

## Unit

```text
pricing
refunds
state transitions
dispatch scoring
permissions
ledger
fraud rules
```

## Integration

```text
Postgres
Redis
PostGIS
S3
PSP sandbox
KYC sandbox
```

## Contract

```text
Paga
Flutterwave
KYC
SMS
Maps
WatchUp
```

## Concurrency

Critical:

```text
two providers accept simultaneously
two payment requests simultaneously
two refunds simultaneously
cancel + provider accept
provider complete + customer cancel
webhook replay
webhook out of order
timer fires after cancellation
Redis restart during dispatch
```

---

# 57. Adversarial tests

This is where a serious engineering team distinguishes itself.

Test:

```text
Tap Pay 20 times
```

Expected:

```text
1 payment
```

Test:

```text
Two providers accept same job
```

Expected:

```text
1 winner
1 rejected
```

Test:

```text
Same webhook 100 times
```

Expected:

```text
1 ledger posting
```

Test:

```text
Provider sends ARRIVED from 5 km away
```

Expected:

```text
location mismatch
```

Test:

```text
Provider changes bank account
```

Expected:

```text
payout cooling period
```

Test:

```text
Redis disappears
```

Expected:

```text
Postgres remains authoritative
timers recover
```

---

# 58. SLOs

Initial targets:

| Metric                              |                Target |
| ----------------------------------- | --------------------: |
| API p95                             |               ≤500 ms |
| Booking creation p95                | ≤800 ms excluding PSP |
| Core availability                   |                 99.9% |
| Mobile crash-free sessions          |                ≥99.5% |
| Payment webhook lag                 |               <60 sec |
| Critical queue age                  |               <60 sec |
| Ledger imbalance                    |                     0 |
| Duplicate successful payments       |                     0 |
| Unauthorized booking access         |                     0 |
| Unexplained reconciliation variance |                     0 |

The supplied architecture already defines these core targets and treats ledger imbalance as SEV-1. 

---

# 59. Critical business metrics

Backend analytics should expose:

```text
booking_conversion
payment_success_rate
provider_acceptance_rate
provider_response_time
time_to_assignment
time_to_arrival
job_completion_rate
cancellation_rate
refund_rate
dispute_rate
warranty_rate
repeat_booking_rate
provider_utilization
provider_earnings
platform_GMV
platform_revenue
contribution_margin
```

Operationally:

```text
unassigned_jobs
late_jobs
failed_payments
failed_payouts
KYC_backlog
open_disputes
queue_age
```

---

# 60. API observability dimensions

Every request should have:

```text
request_id
trace_id
user_id
organization_id
device_id
route
method
status
duration
release
environment
```

But sensitive data must be redacted.

---

# 61. Recommended repository

```text
kendibo/
│
├── apps/
│   ├── api/
│   ├── worker/
│   └── realtime/
│
├── packages/
│   ├── contracts/
│   ├── config/
│   ├── database/
│   ├── observability/
│   └── shared/
│
├── modules/
│   ├── identity/
│   ├── users/
│   ├── authorization/
│   ├── properties/
│   ├── catalog/
│   ├── pricing/
│   ├── bookings/
│   ├── jobs/
│   ├── providers/
│   ├── dispatch/
│   ├── geo/
│   ├── tracking/
│   ├── quotes/
│   ├── payments/
│   ├── ledger/
│   ├── payouts/
│   ├── refunds/
│   ├── disputes/
│   ├── warranties/
│   ├── reviews/
│   ├── messaging/
│   ├── notifications/
│   ├── media/
│   ├── kyc/
│   ├── fraud/
│   ├── b2b/
│   ├── support/
│   ├── configuration/
│   ├── analytics/
│   ├── audit/
│   └── privacy/
│
├── infra/
│   ├── terraform/
│   ├── docker/
│   └── scripts/
│
├── docs/
│   ├── adr/
│   ├── api/
│   ├── architecture/
│   ├── runbooks/
│   └── threat-model/
│
└── tests/
    ├── unit/
    ├── integration/
    ├── contract/
    ├── concurrency/
    ├── security/
    ├── e2e/
    └── load/
```

---

# 62. What should *not* be built yet

Do not allow the backend team to turn this into an uncontrolled enterprise project.

### MVP

Build:

```text
Identity
Users
Properties
Addresses
Catalog
Pricing
Bookings
Job engine
Providers
KYC
Dispatch
Tracking
Payments
Ledger
Notifications
Media
Reviews
Support
Admin
Observability
Audit
```

### P1

```text
Recurring bookings
Subscriptions
B2B
Advanced fraud
WhatsApp provider communication
SMS command fallback
Advanced property maintenance
```

### P2

```text
AI service diagnosis
Predictive maintenance
Dynamic pricing
Advanced provider ranking
Multi-country payments
Multi-currency
Marketplace expansion
```

---

# 63. Recommended engineering sequence

The supplied six-sprint backend delivery plan is sensible; I would retain its general ordering. 

### Phase 0 — Architecture

Build:

```text
monorepo
NestJS
Postgres
PostGIS
Redis
BullMQ
Docker
Terraform
CI
OpenAPI
WatchUp
logging
security baseline
```

### Sprint 1

```text
Identity
RBAC
Users
Devices
Config
Feature flags
Audit
```

### Sprint 2

```text
Properties
Addresses
Catalog
Pricing
Booking
State machine
Payments
Webhook system
```

### Sprint 3

```text
Providers
KYC
Skills
Availability
Provider execution
Offline sync
```

### Sprint 4

```text
Dispatch
Geo
Realtime tracking
Quotes
Change orders
Notifications
```

### Sprint 5

```text
Ledger
Settlement
Refunds
Payouts
Disputes
Warranty
Fraud
Finance
```

### Sprint 6

```text
Security hardening
Load testing
Chaos testing
DR
Privacy workflows
Pen testing
Production readiness
```

---

# 64. The most important architectural rules

I would put these in `ARCHITECTURE.md` and require every engineer to follow them.

### Rule 1

**PostgreSQL is the source of truth.**

Redis is acceleration, not authority.

### Rule 2

**The server owns money.**

The mobile app never determines final payment amounts.

### Rule 3

**The state machine owns job transitions.**

No random:

```ts
booking.status = 'COMPLETED'
```

### Rule 4

**Every money mutation is idempotent.**

### Rule 5

**Every webhook is replay-safe.**

### Rule 6

**Every external service is behind an adapter.**

### Rule 7

**Every sensitive admin action is audited.**

### Rule 8

**Offline clients submit commands, not authoritative state.**

### Rule 9

**Every async operation must tolerate duplicate execution.**

### Rule 10

**No business-critical process depends on a single third-party provider.**

### Rule 11

**Do not start with microservices.**

Extract only when actual scaling/team boundaries justify it.

### Rule 12

**WatchUp must never be allowed to take Kendibo down.**

Telemetry failures must fail open.

WatchUp itself should never sit synchronously inside:

```text
payment
booking
dispatch
```

critical paths.

---

# 65. The final backend picture

The platform should ultimately look like this:

```text
                         Kendibo PLATFORM
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
      CUSTOMER             PROVIDER             B2B
       APP                  APP                 WEB
          │                   │                    │
          └───────────────────┼────────────────────┘
                              │
                         API GATEWAY
                              │
                 ┌────────────┴────────────┐
                 │                         │
             DOMAIN CORE              PLATFORM CORE
                 │                         │
       ┌─────────┼─────────┐       ┌───────┼────────┐
       │         │         │       │       │        │
    Booking   Dispatch   Property  Auth   Config  Notifications
       │         │         │       │       │        │
       └─────────┼─────────┘       └───────┼────────┘
                 │                         │
              JOB ENGINE                EVENTS
                 │                         │
       ┌─────────┼──────────┐              │
       │         │          │              │
    Provider   Tracking   Quotes       Analytics
       │
       └──────────────┐
                      │
                  MONEY CORE
                      │
          ┌───────────┼───────────┐
          │           │           │
       Payments     Ledger      Payouts
          │           │           │
          └───────────┼───────────┘
                      │
              Paga
                      
                      
              OBSERVABILITY PLANE
                      │
       ┌──────────────┼──────────────┐
       │              │              │
    WatchUp       OpenTelemetry   AWS Metrics
       │
       ├── Errors
       ├── API traces
       ├── Business events
       ├── Database signals
       ├── Server signals
       └── WhatsApp/Slack alerts
```

## Bottom line

**Kendibo should be engineered as an operations and financial platform first, and a mobile application second.** The React Native app is the interface; the real product is the backend system that determines *who can perform a service, where, when, at what price, under what conditions, how the job progresses, what evidence exists, where the customer's money sits, when the provider gets paid, and what happens when something goes wrong.*

The architecture in the supplied plan already has the correct foundation — **NestJS modular monolith, PostgreSQL/PostGIS, Redis/BullMQ, Socket.IO, adapter-based integrations, state machine, ledger, Terraform/ECS and strong reconciliation**.  The additional hardening above turns that foundation into the backend specification I would use to split the work into engineering epics, database migrations, API contracts, integration tasks, infrastructure tickets and production-readiness gates.

For **WatchUp specifically**, I would integrate it from Phase 0 rather than after launch: errors, traces, deployment releases and Kendibo business-critical events should be observable from the first staging environment, with WhatsApp alerting for the on-call path. WatchUp's current public documentation/material supports Node.js request tracing, error capture, custom events and alerting, while its public API/SDK approach means Kendibo should keep the integration behind its own `ObservabilityPort` rather than coupling business modules directly to WatchUp. ([watchup.site][1])

[1]: https://watchup.site/blog/affordable-monitoring-africa?utm_source=chatgpt.com "Affordable Application Monitoring for African Startups in 2025 — WatchUp Blog"
[2]: https://pypi.org/project/watchup/0.3.0/?utm_source=chatgpt.com "watchup · PyPI"
[3]: https://watchup.site/blog/whatsapp-alerts-devops?utm_source=chatgpt.com "WhatsApp Alerts for DevOps: Why Engineering Teams Use WhatsApp for Incidents — WatchUp Blog"
