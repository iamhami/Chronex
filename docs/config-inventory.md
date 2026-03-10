# Operational Config Inventory

Secret names follow the convention `CHRONEX_<DOMAIN>_<KEY>`.

| Key | Runtime | Domain | Owner | Rotation | Scope | Required | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `API_PORT` | API | Platform | Platform | N/A | local, staging, prod | Yes | Non-secret numeric port |
| `DATABASE_URL` | API | Platform | Platform | 90 days | local, staging, prod | Yes | Primary relational database connection |
| `JWT_SECRET` | API | Identity | Security | 30 days | local, staging, prod | Yes | High-risk signing secret |
| `ENCRYPTION_KEY_ID` | API | Security | Security | 30 days | local, staging, prod | Yes | Points to active KMS or envelope key |
| `STRIPE_SECRET_KEY` | API | Billing | Payments | 30 days | local, staging, prod | No | Server-side billing operations only |
| `PUBLIC_API_BASE_URL` | Web | Platform | Frontend | N/A | local, staging, prod | Yes | Public API origin |
| `PUBLIC_STRIPE_PUBLISHABLE_KEY` | Web | Billing | Payments | 90 days | local, staging, prod | No | Public Stripe key only |
