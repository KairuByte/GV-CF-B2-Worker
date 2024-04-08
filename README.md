# Requirements

- Cloudflare account
- Owned domain
- GameVault set up and configured
- GameVault exposed to the open internet (cloudflare tunnels work just fine)

# Steps to use

1. Create a new cloudflare worker [here](https://dash.cloudflare.com/?to=/:account/workers)
2. Edit the worker settings as follows:
    1. Set the route of the worker to `[gamevault base domain]/api/games/*`.
       - You likely want to disable the default route.
    2. Create the following variables:
        | Variable name | Value | Required? |
        | --- | --- | --- |
        | B2_APPLICATION_KEY	| Your B2 application key, encrypted. | Required |
        | B2_APPLICATION_KEY_ID | Your B2 application key ID. | Required |
        | B2_ENDPOINT | Your S3 endpoint - e.g. s3.us-west-001.backblazeb2.com | Required |
        | BUCKET_NAME | Your B2 bucket name | Required |
        | DISCORD_WEBHOOK | Your discord webhook to push download stats to. | Optional |
        | GV_FOLDER | The folder inside your bucket where GV games are stored | Required |
        | GV_HOSTNAME | The hostname of your GameVault server. | Required |
6. Replace the workers code with `worker.js` within this repo
7. Upload a copy of [aws4fetch.cjs.js](https://github.com/mhart/aws4fetch) alongside `worker.js`
