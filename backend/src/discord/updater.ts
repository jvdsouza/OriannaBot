import RiotAPI from "../riot/api";
import * as eris from "eris";
import { Server, User, LeagueAccount, UserRank, UserChampionStat, Role } from "../database";
import config from "../config";
import DiscordClient from "./client";
import StaticData from "../riot/static-data";
import debug = require("debug");
import elastic from "../elastic";

const logUpdate = debug("orianna:updater:update");
const logFetch = debug("orianna:updater:fetch");
const logMastery = debug("orianna:updater:fetch:mastery");
const logRanked = debug("orianna:updater:fetch:ranked");
const logAccounts = debug("orianna:updater:fetch:accounts");
const logGames = debug("orianna:updater:fetch:games");

/**
 * The updater is responsible for "updating" user ranks every set interval.
 * This updater actually runs 3 different updating loops, each at different intervals.
 * From ran most often to ran least often:
 * - Update Mastery Scores (level, score)
 * - Update Ranked Information (amount of games, ranked tier)
 * - Update Summoners (check if the summoner was renamed, transferred)
 * These different intervals are mostly because of the rate limits imposed on us by
 * the Riot API. Do note that a manual refresh will do all of these at the same time.
 *
 * Terminology used:
 * - fetch: pulling (new) data from the riot API and writing it to a User instance.
 *          this will **not** recalculate roles in discord.
 * - update: calculate new roles for a user based on their current User instance.
 *           this should be ran when either the role conditions change or the user
 *           was previously fetched (and thus might have new data)
 */
export default class Updater {
    constructor(private client: DiscordClient, private riotAPI: RiotAPI) {}

    /**
     * Updates everything for the specified user instance or snowflake. This
     * will fetch all the new data and then recompute all roles for the specified user.
     */
    public async fetchAndUpdateAll(user: User | string) {
        if (typeof user === "string") {
            const dbUser = await User
                .query()
                .where("snowflake", user)
                .eager("[accounts, stats, ranks]")
                .first();

            if (!dbUser) throw new Error("User " + user + " not found.");
            user = dbUser;
        }
        logFetch("Fetching and updating all for %s (%s)", user.username, user.snowflake);

        try {
            // Run the account update and games count first since it may alter the results
            // of the other fetch queries (if a user transferred).
            await this.fetchAccounts(user);
            await this.fetchGamesPlayed(user);

            await Promise.all([
                this.fetchMasteryScores(user),
                this.fetchRanked(user)
            ]);

            await this.updateUser(user);
        } catch (e) {
            logFetch("Error fetching or updating for user %s (%s): %s", user.username, user.snowflake, e.message);
            logFetch("%O", e);

            elastic.reportError(e);
        }
    }

    /**
     * Updates the roles for the specified User on all servers Orianna
     * shars with them. This will not fetch data, it will just check to
     * see if the user has all the roles it is supposed to have and
     * update appropriately. Thus, this should be called after a fetch
     * or whenever the role configuration for a specific server is updated.
     */
    private async updateUser(user: User) {
        logUpdate("Updating roles for user %s (%s)", user.username, user.snowflake);

        try {
          await Promise.all(this.client.bot.guilds.filter(x => x.members.has(user.snowflake)).map(server => {
              return this.updateUserOnGuild(user, server);
          }));
        } catch (e) {
            logUpdate("Failed to update roles for user %s (%s): %s", user.username, user.snowflake, e.message);
            logUpdate("%O", e);

            // Rethrow, something else will catch it.
            throw e;
        }
    }

    /**
     * Recalculates all the roles for the specified user in the specified
     * Discord guild. Does nothing if the guild is not registered in the database.
     */
    private async updateUserOnGuild(user: User, guild: eris.Guild) {
        const server = await Server
            .query()
            .where("snowflake", guild.id)
            .eager("roles.conditions")
            .first();
        if (!server) return;

        const member = guild.members.get(user.snowflake);
        if (!member) return;

        logUpdate("Updating roles for user %s (%s) on guild %s (%s)", user.username, user.snowflake, server.name, server.snowflake);

        // Compute all roles that this server may assign, then compute all roles that the user should have.
        // Subtract those two sets to figure out which roles the user should and shouldn't have, then make
        // sure that that corresponds with the roles the user currently has on the server.
        const allRoles = new Set(server.roles!.map(x => x.snowflake));
        const shouldHave = new Set(server.roles!.filter(x => x.test(user)).map(x => x.snowflake));
        const userHas = new Set(member.roles);

        for (const role of allRoles) {
            if (!guild.roles.has(role)) continue;
            // TODO(molenzwiebel): Make sure that assigning succeeds, notify the owner if we lack permissions.

            // User has the role, but should not have it.
            if (userHas.has(role) && !shouldHave.has(role)) guild.removeMemberRole(user.snowflake, role, "Orianna - User does not meet requirements for this role.");

            // User does not have the role, but should have it.
            if (!userHas.has(role) && shouldHave.has(role)) {
                guild.addMemberRole(user.snowflake, role, "Orianna - User meets requirements for role.");

                this.announcePromotion(user, server.roles!.find(x => x.snowflake === role)!, guild);
            }
        }
    }

    /**
     * Responsible for pulling new mastery score data from Riot and
     * updating the User instance. This will not recalculate roles.
     */
    private async fetchMasteryScores(user: User) {
        if (!user.accounts) user.accounts = await user.$relatedQuery<LeagueAccount>("accounts");
        if (!user.stats) user.stats = await user.$relatedQuery<UserChampionStat>("stats");
        logMastery("Updating mastery for user %s (%s)", user.username, user.snowflake);

        // Sum scores and max levels for all accounts.
        const scores = new Map<number, { score: number, level: number }>();
        for (const account of user.accounts) {
            const masteries = await this.riotAPI.getChampionMastery(account.region, account.summoner_id);
            for (const mastery of masteries) {
                const old = scores.get(mastery.championId) || { score: 0, level: 0 };
                scores.set(mastery.championId, {
                    score: old.score + mastery.championPoints,
                    level: old.level > mastery.championLevel ? old.level : mastery.championLevel
                });
            }
        }

        // Nuke all old entries (in case the user removed an account) and append the new values.
        for (const [champion, score] of scores) {
            // Carry over the old games played. Don't update anything if we have no need to.
            const oldScore = user.stats.find(x => x.champion_id === champion);
            if (oldScore && score.level === oldScore.level && score.score === oldScore.score) continue;
            if (oldScore) await oldScore.$query().delete();

            const oldGamesPlayed = oldScore ? oldScore.games_played : 0;
            await user.$relatedQuery<UserChampionStat>("stats").insert({
                champion_id: champion,
                level: score.level,
                score: score.score,
                games_played: oldGamesPlayed
            });
        }

        // Refetch stats now that we updated stuff.
        user.stats = await user.$relatedQuery<UserChampionStat>("stats");
    }

    /**
     * Responsible for pulling new ranked tiers and play counts and
     * updating the User instance. This will not recalculate roles.
     */
    private async fetchRanked(user: User) {
        if (!user.accounts) user.accounts = await user.$relatedQuery<LeagueAccount>("accounts");
        logRanked("Updating ranked stats for user %s (%s)", user.username, user.snowflake);

        // Figure out the highest rank in every queue for all the accounts combined.
        const tiers = new Map<string, number>();
        for (const account of user.accounts) {
            const results = await this.riotAPI.getLeaguePositions(account.region, account.summoner_id);
            for (const result of results) {
                const old = tiers.get(result.queueType) || 0;
                const val = config.riot.tiers.indexOf(result.tier);
                tiers.set(result.queueType, old > val ? old : val);
            }
        }

        // Nuke all old entries (since there might be a queue where we are no longer ranked),
        // then append the new values.
        await user.$relatedQuery<UserRank>("ranks").delete();
        user.ranks = [];
        for (const [queue, tier] of tiers) {
            await user.$relatedQuery<UserRank>("ranks").insert({
                queue,
                tier: config.riot.tiers[tier]
            });
        }
    }

    /**
     * Loads the amount of ranked games played across all champions and all regions
     * for the specified user. Note that this will update even if it was updated recently.
     */
    private async fetchGamesPlayed(user: User) {
        if (!user.accounts) user.accounts = await user.$relatedQuery<LeagueAccount>("accounts");
        if (!user.stats) user.stats = await user.$relatedQuery<UserChampionStat>("stats");
        logGames("Updating ranked games played for user %s (%s)", user.username, user.snowflake);

        const gamesPlayed = new Map<number, number>();
        for (const account of user.accounts) {
            const games = await this.riotAPI.findRankedGamesAfter(account.region, account.account_id, 0); // TODO: Update timestamp.

            for (const game of games) {
                // Increment the amount of games played by one.
                gamesPlayed.set(game.champion, (gamesPlayed.get(game.champion) || 0) + 1);
            }
        }

        // Now, update the database totals.
        const incremental = false; // TODO: Either completely refetch if an account was removed or add up if we had an old timestamp.
        for (const [champion, games] of gamesPlayed) {
            const oldValue = user.stats.find(x => x.champion_id === champion);

            // Skip updating this if the value we have is already the most recent. Saves us a database call.
            if (oldValue && (incremental ? games === 0 : oldValue.games_played === games)) continue;

            // Weird, but it can happen I guess.
            if (!oldValue) {
                await user.$relatedQuery<UserChampionStat>("stats").insert({
                    champion_id: champion,
                    level: 0,
                    score: 0,
                    games_played: games
                });
            } else {
                await oldValue.$query().update({
                    games_played: incremental ? oldValue.games_played + games : games
                });
            }
        }

        // Refetch stats now that we updated stuff,
        user.stats = await user.$relatedQuery<UserChampionStat>("stats");
    }

    /**
     * Responsible for refreshing summoner instances to check if the
     * user renamed or transferred. This will not recalculate roles.
     */
    private async fetchAccounts(user: User) {
        if (!user.accounts) user.accounts = await user.$relatedQuery<LeagueAccount>("accounts");
        logAccounts("Updating accounts for user %s (%s)", user.username, user.snowflake);

        // For every account, check if the account still exists and still has the same name.
        // If the name is different, just silently update. Else, remove the account and message
        // the user that we removed their account.
        const copy = user.accounts.slice();
        for (const account of copy) {
            const summoner = await this.riotAPI.getSummonerById(account.region, account.summoner_id);

            if (!summoner) {
                logAccounts("User %s (%s) seems to have transferred account %s - %s (%i)", user.username, user.snowflake, account.region, account.username, account.summoner_id);

                // Delete the account.
                await account.$query().delete();
                user.accounts.slice(user.accounts.indexOf(account), 1);

                // Potentially notify the user.
                this.client.notify(user.snowflake, {
                    color: 0x0a96de,
                    title: "✈ Account Transferred?",
                    description: "You registered your League account **" + account.username + "** (" + account.region + ") with me a while ago. While checking up on it today, it seems that the account no longer exists. Did you transfer the account to another region?\n\nI have unlinked the League account from your Discord profile. If you have indeed transferred, you can simply add the account again in the new region."
                });
            } else if (summoner.name !== account.username) {
                logAccounts("User %s (%s) seems to have renamed account %s - %s to %s", user.username, user.snowflake, account.region, account.username, summoner.name);

                account.username = summoner.name;
                await account.$query().update({
                    username: summoner.name
                });
            }
        }
    }

    /**
     * Announces promotion for the specified user and the specified role on the
     * specified guild, if enabled.
     */
    private async announcePromotion(user: User, role: Role, guild: eris.Guild) {
        if (!role.announce) return;

        // Find announcement channel ID.
        const server = await Server.query().where("id", role.server_id).first();
        if (!server) return;
        const announceChannelId = server.announcement_channel;
        if (!announceChannelId) return;

        // Ensure that that channel exists.
        const announceChannel = guild.channels.get(announceChannelId);
        if (!announceChannel || !(announceChannel instanceof eris.TextChannel)) return;

        logUpdate("Announcing promotion for %s (%s) to %s on %s (%s)", user.username, user.snowflake, role.name, guild.name, guild.id);

        // Figure out what images to show for the promotion.
        const champion = role.findChampion();
        const championIcon = champion ? await StaticData.getChampionIcon(champion) : "https://i.imgur.com/uW9gZWO.png";
        const championBg = champion ? await StaticData.getRandomCenteredSplash(champion) : "https://i.imgur.com/XVKpmRV.png";

        // Enqueue rendering of the gif.
        const image = await this.client.puppeteer.render("./graphics/promotion.html", {
            gif: {
                width: 800,
                height: 220,
                length: 2.4,
                fpsScale: 1.4
            },
            args: {
                name: user.username,
                title: role.name,
                icon: user.avatarURL,
                champion: championIcon,
                background: championBg
            }
        });

        // Send image!
        announceChannel.createMessage({
            embed: {
                color: 0x49bd1a,
                timestamp: new Date().toISOString(),
                image: { url: "attachment://promotion.gif" },
                author: {
                    name: user.username + " just got promoted to " + role.name + "!",
                    icon_url: user.avatarURL
                }
            }
        }, { file: image, name: "promotion.gif" });
    }
}