import * as request from "./requester"

const BASE_URL = 'http://localhost:3030/data/games';

export const getAll = async () => {
    const result = await request.get(BASE_URL);
    const games = Object.values(result);
    return games;
};

export const getLatest = async () => {
    const urlSearchParams = new URLSearchParams({
        sortBy: '_createdOn desc',
        pageSize: 3,
    });

    const result = await request.get(`${BASE_URL}?${urlSearchParams.toString()}`);
    const latesGames = Object.values(result);
    return latesGames;
}

export const getOne = (gameId) => request.get(`${BASE_URL}/${gameId}`);

export const create = (gameData) => request.post(`${BASE_URL}`, gameData);

export const remove = (gameId) => request.del(`${BASE_URL}/${gameId}`);

export const update = (gameId, gameData) => request.put(`${BASE_URL}/${gameId}`, gameData);

const gamesAPI = {
    getAll,
    getOne,
    create,
    remove,
    update,
    getLatest,
};

export default gamesAPI;