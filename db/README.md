# Pipeline jobs database

The clip pipeline stores queued jobs and dashboard progress in PostgreSQL. Other application features may continue to use Redis.

## Configure

1. Create a PostgreSQL database with your provider.
2. Apply `migrations/001_pipeline_jobs.sql` to that database.
3. Set `DATABASE_URL` to the Neon connection string for both the Vercel production project and the background worker service. Use the pooled connection string for Vercel's serverless API; the worker can use the same URL.
4. If the connection string does not declare its SSL mode, the API and worker require TLS by default. Set `DATABASE_SSL=disable` only for a trusted local database that does not support TLS.
5. The Render Blueprint in `render.yaml` defines a persistent background worker using `server/Dockerfile`. Create a Blueprint in Render from this repository and provide `DATABASE_URL` and the full `VENUES_CONFIG` when prompted. Its Ohio region is selected to keep the worker near the Neon project.

The job table stores upload IDs, venue slugs, progress, and status. It does not store Mux credentials; the worker resolves credentials from its existing venue configuration.

## Cut over

1. Pause new pipeline submissions and allow any currently running Redis pipeline job to finish.
2. Apply the schema and configure `DATABASE_URL` on the worker and Vercel.
3. Deploy the Render worker first and confirm its logs show `Postgres Connected` and `Polling pipeline_jobs for work`.
4. Deploy the API code from this change to Vercel.
5. Submit one test video and confirm the worker claims the job and advances its status in the dashboard.
6. Resume submissions. Redis can remain configured for unrelated features.

Jobs already queued in Redis are not copied automatically. After cutover, re-submit eligible videos whose source Mux assets still exist. Do not remove the Redis service or its app-wide configuration until other Redis consumers have been migrated separately.