This is a cloudflare worker configuration for use in front of a GameVault server. It watches the `~/api/games/*` API endpoint, and redirects downloads to content served from Backblaze B2. As the content is served through cloudflare, you are not charged an egress fee on any of the bandwidth.

# Requirements

- A free Cloudflare account
- An owned domain with DNS records pointing to your gamevault server on Cloudflare
- A GameVault server set up and configured
  - GameVault server exposed to the open internet (cloudflare tunnels work just fine)
- A Backblaze B2 account
- Game files mirrored onto the B2 account.
  - Optionally, you can use rclone to mount the B2 bucket on the GameVault server, to cut down on the work.

# Steps to use

1. Create a new cloudflare worker [here](https://dash.cloudflare.com/?to=/:account/workers)
2. Edit the worker settings as follows:
    1. Set the route (in Settings>Triggers) of the worker to `[gamevault base domain]/api/games/*`.
       - You likely want to disable the default route.
    2. Create the following variables (in Settings>Variables):
        | Variable name | Value | Example | Required? |
        | --- | --- | --- | --- |
        | B2_APPLICATION_KEY	| Your B2 application key, encrypted. | ~00123b4567df3c60000000007~ | Required |
        | B2_APPLICATION_KEY_ID | Your B2 application key ID. | ~K001mcp0RsiEJe/Viw90bvjkZZPzRSE~ | Required |
        | B2_ENDPOINT | Your S3 endpoint | s3.us-west-001.backblazeb2.com | Required |
        | BUCKET_NAME | Your B2 bucket name | GameVault | Required |
        | DISCORD_WEBHOOK | Your discord webhook to push download stats to. | https://discord.com/api/webhooks/{webhook.id}/{webhook.token} | Optional |
        | GV_FOLDER | The folder inside your bucket where GV games are stored. Needs leading and trailing slash.  | `/` or `/gamevault/` | Required |
        | GV_INTERNAL_FOLDER | The internal gamevault folder. You can check this by looking in your game API response. | `files` for Docker; `games` for TrueNAS | Required |
        | LOG_LEVEL | The log level to output to Discord. | `INFO` | Optional |
6. Replace the workers code with `worker.js` within this repo
7. Upload a copy of [aws4fetch.esm.js](https://github.com/mhart/aws4fetch) alongside `worker.js`

# Log Level

The only log levels in place are `ERROR`, `INFO` and `DEBUG`.

The full list is as follows:
- `ERROR`
- `WARN`
- `INFO`
- `DEBUG`
- `TRACE`
