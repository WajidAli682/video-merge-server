# video-merge-server

HeyGen scene clips ko trim + merge karke ek final watermark-free video banata hai.
Job-based: submit karo, jobId milta hai, poll karo jab tak `done` na ho.

## Deploy (Railway)

1. Naya Railway project banao (ya GitHub repo se deploy)
2. Repo mein ye saari files push karo (`Dockerfile` already hai — Railway use khud detect kar lega)
3. Deploy hone ke baad Railway tumhe ek public URL dega (jaise `https://video-merge-server-production.up.railway.app`)

## API

### `POST /merge`

Request body:
```json
{
  "clips": [
    { "url": "https://files2.heygen.ai/.../avatar1.mp4", "type": "avatar" },
    { "url": "https://amazonaws.com/.../footage1.mp4", "type": "footage", "trimNeeded": true, "trimEnd": 4.2 },
    { "url": "https://files2.heygen.ai/.../avatar2.mp4", "type": "avatar" }
  ]
}
```

- `url` — required, clip ka direct (signed) download URL
- `trimNeeded` + `trimEnd` — agar true, clip ko `[0, trimEnd]` second tak trim kiya jayega. Avatar clips ke liye ye bhejne ki zaroorat nahi (poori clip use hoti hai).
- Clips **sequence mein** bhejo jaisi order final video mein chahiye.

Response (turant):
```json
{ "jobId": "a1b2c3d4-..." }
```

### `GET /status/:jobId`

Response (processing ke dauran):
```json
{ "status": "processing", "progress": 45, "total": 7 }
```

Response (jab done ho jaye):
```json
{
  "status": "done",
  "progress": 100,
  "downloadUrl": "/files/a1b2c3d4-.../final.mp4"
}
```

`downloadUrl` ko server ke base URL ke saath jodo:
`https://<your-railway-url>` + `downloadUrl` = final video link.

Status values: `queued` → `downloading` → `processing` → `merging` → `done` (ya `error`)

## Notes

- Final video Railway disk pe temporary store hoti hai — 2 ghante baad auto-delete ho jati hai (cleanup job)
- Background music skip ki jati hai — sirf clips ka apna audio rakha jata hai
- Saari clips 1920x1080 @ 30fps pe normalize hoti hain merge se pehle (taake concat fail na ho)
