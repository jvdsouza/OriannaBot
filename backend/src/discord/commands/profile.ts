import { Command } from "../command";
import { differenceInDays } from "date-fns";
import { emote, expectUserWithAccounts } from "./util";
import { UserChampionStat, UserMasteryDelta, UserRank } from "../../database";
import formatName from "../../util/format-name";
import generateProfileGraphic from "../../graphics/profile";

const ProfileCommand: Command = {
    name: "Show User Profile",
    smallDescriptionKey: "command_profile_small_description",
    descriptionKey: "command_profile_description",
    keywords: ["list", "accounts", "name", "show", "profile", "account", "summoner"],
    async handler({ ctx, info, client, t }) {
        const target = await expectUserWithAccounts(ctx);
        if (!target) return;

        // Query some data we need later.
        const topMastery = await target.$relatedQuery<UserChampionStat>("stats").orderBy("score", "DESC").where("score", ">", 0).limit(8);
        const recentlyPlayed = await UserMasteryDelta.query().where("user_id", target.id).select("champion_id", "timestamp").orderBy("timestamp", "desc").limit(10);
        const uniqueRecentlyPlayed = recentlyPlayed.filter((e, i, a) => a.findIndex(x => x.champion_id === e.champion_id) === i);
        const levelCounts: { level: number, count: number }[] = <any>await target.$relatedQuery("stats").groupBy("level", "user_id").count().select("level");
        const totalMastery: string[] = <any>await target.$relatedQuery("stats").sum("score").groupBy("user_id").pluck("sum");
        const avgMastery: string[] = <any>await target.$relatedQuery("stats").avg("score").groupBy("user_id").pluck("avg");
        const rankedData = await target.$relatedQuery<UserRank>("ranks");

        // Formatting helpers.
        const champ = async (entry: UserChampionStat | UserMasteryDelta) => emote(ctx, await t.staticData.championById(entry.champion_id)) + " " + (await t.staticData.championById(entry.champion_id)).name;
        const amount = (entry: UserChampionStat) =>
            entry.score < 10000 ? entry.score.toLocaleString() :
            entry.score >= 1000000 ? `${(entry.score / 1000000).toFixed(2).replace(/[.,]00$/, "")}m`
            : `${Math.round(entry.score / 10000) * 10}k`;
        const levelCount = (level: number) => levelCounts.find(x => x.level === level) ? levelCounts.find(x => x.level === level)!.count : 0;
        const formatRank = (rank: string) => (<any>{
            "UNRANKED": t.ranked_tier_unranked + emote(ctx, "__"),
            "IRON": `${emote(ctx, "Iron")} ` + t.ranked_tier_iron,
            "BRONZE": `${emote(ctx, "Bronze")} ` + t.ranked_tier_bronze,
            "SILVER": `${emote(ctx, "Silver")} ` + t.ranked_tier_silver,
            "GOLD": `${emote(ctx, "Gold")} ` + t.ranked_tier_gold,
            "PLATINUM": `${emote(ctx, "Platinum")} ` + t.ranked_tier_platinum,
            "DIAMOND": `${emote(ctx, "Diamond")} ` + t.ranked_tier_diamond,
            "MASTER": `${emote(ctx, "Master")} ` + t.ranked_tier_master,
            "GRANDMASTER": `${emote(ctx, "Grandmaster")} ` + t.ranked_tier_grandmaster,
            "CHALLENGER": `${emote(ctx, "Challenger")} ` + t.ranked_tier_challenger
        })[rank];
        const queueRank = (queue: string) =>
            target.treat_as_unranked ? formatRank("UNRANKED") :
            rankedData.find(x => x.queue === queue) ? formatRank(rankedData.find(x => x.queue === queue)!.tier) : formatRank("UNRANKED");
        const daysAgo = (entry: UserMasteryDelta) => {
            const diff = Math.abs(differenceInDays(+entry.timestamp, new Date()));
            if (diff === 0) return t.time_ago_today;
            if (diff === 1) return t.time_ago_yesterday;
            return t.time_ago_days_ago({ days: diff });
        };

        const fields: { name: string, value: string, inline: boolean }[] = [{
            name: t.command_profile_top_champions,
            value: (await Promise.all(topMastery.slice(0, 3).map(async x =>
                `${await champ(x)}\u00a0-\u00a0**${amount(x)}**`
            ))).join("\n") + "\n" + emote(ctx, "__"),
            inline: true
        }, {
            name: t.command_profile_statistics,
            value: [
                `${levelCount(7)}x${emote(ctx, "Level_7")}\u00a0${levelCount(6)}x${emote(ctx, "Level_6")}\u00a0${levelCount(5)}x${emote(ctx, "Level_5")}${emote(ctx, "__")}`,
                t.command_profile_statistics_total_points({ amount: +totalMastery[0] }) + emote(ctx, "__"),
                t.command_profile_statistics_avg_champ({ amount: t.number(+avgMastery[0], 2) }) + emote(ctx, "__"),
                `${emote(ctx, "__")}`
            ].join("\n"),
            inline: true
        }, {
            name: t.command_profile_recently_played,
            value: ((await Promise.all(uniqueRecentlyPlayed.slice(0, 3).map(async x =>
                (await champ(x)) + "\u00a0-\u00a0**" + daysAgo(x) + "**"
            ))).join("\n") || t.command_profile_recently_played_no_games) + "\n" + emote(ctx, "__"),
            inline: true
        }, {
            name: t.command_profile_ranked_tiers,
            value: [
                `${t.queue_ranked_solo}:\u00a0**${queueRank("RANKED_SOLO_5x5")}**`,
                `${t.queue_ranked_flex}:\u00a0**${queueRank("RANKED_FLEX_SR")}**`,
                `${t.queue_ranked_tft}:\u00a0**${queueRank("RANKED_TFT")}**`
            ].join("\n") + "\n" + emote(ctx, "__"),
            inline: true
        }];

        // Only add accounts if the user has not toggled them off.
        if (!target.hide_accounts) {
            // Sort user's accounts based on region. Slice to sort a copy, since sort also modifies the source.
            const sorted = target.accounts!.slice(0).sort((a, b) => a.region.localeCompare(b.region));

            // Split up in columns if more than two, single field else.
            if (sorted.length > 1) {
                const left = sorted.slice(0, Math.ceil(sorted.length / 2));
                const right = sorted.slice(left.length);

                // Make the ranked tiers not inline.
                fields[fields.length - 1].inline = false;

                fields.push({
                    name: t.command_profile_accounts,
                    value: left.map(x => x.region + "\u00a0-\u00a0" + x.username).join("\n") + "\n" + emote(ctx, "__"),
                    inline: true
                }, {
                    name: "\u200b", // renders as an empty title in discord
                    value: right.map(x => x.region + "\u00a0-\u00a0" + x.username).join("\n") + "\n" + emote(ctx, "__"),
                    inline: true
                })
            } else {
                fields.push({
                    name: t.command_profile_account,
                    value: sorted[0].region + "\u00a0-\u00a0" + sorted[0].username + "\n" + emote(ctx, "__"),
                    inline: true
                });
            }
        }

        // Render a neat bar chart with the top 8 champions.
        const colors: { [key: string]: string } = {
            Mage: "#6cace2",
            Marksman: "#cc708d",
            Support: "#1eb59b",
            Fighter: "#916063",
            Tank: "#888690",
            Assassin: "#c0964c"
        };

        const values = await Promise.all(topMastery.map(async x => ({
            champion: (await t.staticData.championById(x.champion_id)).name,
            color: colors[(await t.staticData.championById(x.champion_id)).tags[0]],
            score: x.score
        })));

        const image = await generateProfileGraphic(values);

        return info({
            title: t.command_profile_title({ name: formatName(target) }),
            fields,
            file: {
                name: "chart.png",
                file: image
            }
        });
    }
};
export default ProfileCommand;
