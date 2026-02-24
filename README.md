# Horoj Haniya (هروج هانيه)

Real-time multiplayer GIF reaction party game designed for Discord voice channels via the official Embedded App SDK.

## Stack

- Frontend: Next.js + React + Tailwind + Framer Motion + Socket.IO client
- Backend: Node.js + Express + Socket.IO + Klipy API proxy

## Monorepo Layout

- `backend/` Socket.IO game server (`server.js`)
- `frontend/` Next.js app (`app/page.tsx`)

## Features Implemented

- Real-time room state machine:
  - `LOBBY -> PROMPT_REVEAL -> GIF_SEARCH -> VOTING -> ROUND_RESULTS`
- Hardcoded admin check by Discord ID: `217998454197190656`
- Deck manager in lobby for admin:
  - Deck mode: `DEFAULT | CUSTOM | MIXED`
  - Min players: `1..3`
  - Add custom prompts with both EN + AR
- Bilingual UI:
  - EN default, AR toggle
  - dynamic `dir` switch (`ltr` / `rtl`)
- Klipy GIF search through backend proxy endpoint:
  - `GET /api/klipy/search`
- Animated podium results:
  - top 3 ranked GIFs reveal from 3rd to 1st
  - crown emoji on first place player and GIF card
- Audio placeholder hook `useGameAudio()` with explicit commented `new Audio(...)` calls.

## Local Setup

### 1) Backend

```bash
cd backend
npm install
copy .env.example .env
npm run dev
```

### 2) Frontend

```bash
cd frontend
npm install
copy .env.local.example .env.local
npm run dev
```

Frontend defaults to `http://localhost:3000`, backend to `http://localhost:3001`.

## Environment Variables

### Backend (`backend/.env`)

- `PORT`
- `CORS_ORIGIN`
- `KLIPY_API_KEY`

### Frontend (`frontend/.env.local`)

- `NEXT_PUBLIC_DISCORD_CLIENT_ID`
- `NEXT_PUBLIC_BACKEND_BASE_URL`
- `NEXT_PUBLIC_URL_MAPPING_PREFIX`

## Discord URL Mapping

Frontend uses `NEXT_PUBLIC_BACKEND_BASE_URL` outside Discord.  
When embedded in Discord, the app routes API and Socket.IO through `NEXT_PUBLIC_URL_MAPPING_PREFIX` (for example `/proxy`) and also applies `patchUrlMappings(...)` for compatibility.

## Test Commands

```bash
cd backend && npm test
cd frontend && npm test
```
