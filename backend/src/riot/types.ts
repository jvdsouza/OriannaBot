// This file contains incomplete definitions for Riot API DTO's.
namespace riot {
    export interface Summoner {
        name: string;
        id: number;
        accountId: number;
        profileIconId: number;
    }

    export interface ChampionMasteryInfo {
        championPoints: number;
        championId: number;
        championLevel: number;
    }

    export interface LeagueEntry {
        queueType: string;
        tier: string;
    }

    export interface Champion {
        id: string;
        key: string;
        name: string;
        title: string;
    }
}