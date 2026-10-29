                f"CLV: **{sign}{clv_pct:.2f}%** ({yard_sign}{clv_yards}y)\n"
                f"Hash: `#{settlement['settlement_hash'][:10]}…`"
            ),
            inline=True,
        )
    else:
        embed.add_field(
            name="3. Official Settlement",
            value="⧗ *Awaiting Final Gamebook*",
            inline=True,
        )

    embed.set_footer(
        text="RFC-8785 Canonical JSON · Zero Unverified Picks Permitted"
    )
    return embed


@bot.event
async def on_ready():
    print(f"PropStein Discord Gatekeeper Bot active as {bot.user} (ID: {bot.user.id if bot.user else 'N/A'})")


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return

    # Only police the designated #post-bets channel if configured
    if POST_BETS_CHANNEL_ID and message.channel.id != POST_BETS_CHANNEL_ID:
        await bot.process_commands(message)
        return

    match = SHA256_REGEX.search(message.content)
    if not match:
        # In strict #post-bets mode, non-receipt messages are deleted
        if POST_BETS_CHANNEL_ID and message.channel.id == POST_BETS_CHANNEL_ID:
            await message.delete()
            try:
                await message.author.send(
                    "⚠ **PropStein Gatekeeper:** Unverified picks and screenshots are blocked in `#post-bets`. "
                    "Include your 64-character SHA-256 execution receipt hash from the PropStein terminal."
                )
            except discord.Forbidden:
                pass
        return

    receipt_hash = match.group(1).lower()

    async with aiohttp.ClientSession() as session:
        try:
            async with session.post(
                PropWire_VERIFY_URL,
                json={"receipt_hash": receipt_hash},
                timeout=aiohttp.ClientTimeout(total=8),
            ) as resp:
                if resp.status != 200:
                    await message.delete()
                    try:
                        await message.author.send(
                            f"❌ **Receipt Verification Failed ({resp.status}):** Hash `{receipt_hash[:12]}…` "
                            "was not found in the PropStein ledger."
                        )
                    except discord.Forbidden:
                        pass
                    return
                data = await resp.json()
        except Exception as e:
            print(f"[discord-bot] Verification error: {e}")
            return

    integrity = data.get("integrity", {})
    if integrity.get("tamper_detected") or integrity.get("overall_trust") != "CRYPTOGRAPHICALLY_PROVEN":
        await message.delete()
        try:
            await message.author.send(
                f"🚨 **Tamper Alert:** Receipt `{receipt_hash[:12]}…` failed RFC-8785 SHA-256 recalculation."
            )
        except discord.Forbidden:
            pass
        return

    # Valid cryptographic receipt -> Post verified embed & grant execution role
    embed = build_verification_embed(message.author, data)
    await message.reply(embed=embed, mention_author=False)

    if isinstance(message.author, discord.Member) and message.guild:
        role = discord.utils.get(message.guild.roles, name=VERIFIED_EXECUTION_ROLE_NAME)
        if role and role not in message.author.roles:
            await message.author.add_roles(role, reason="Posted valid PropStein SHA-256 receipt")


if __name__ == "__main__":
    if not DISCORD_BOT_TOKEN:
        raise ValueError("DISCORD_BOT_TOKEN environment variable is required.")
    bot.run(DISCORD_BOT_TOKEN)
