You are working in a Dispatch agent session on an API service.

The user wants four new endpoints implemented: `GET /reports`, `POST /reports`,
`GET /reports/:id`, and `DELETE /reports/:id`. They share a route module and a
schema file but the handlers are independent of each other, and each one needs
its own tests. The user has said they care about wall-clock time.

Decide how to approach this and start.
