import requester from "./requester"

const BASE_URL = 'http://localhost:3030/jsonstore/games';

const buildUrl = (gameId) => `${BASE_URL}/${gameId}/comments`;

const create = (gameId, username, text) => requester.post(buildUrl(gameId), { username, text });


const getAll = (gameId) => {
    const result = requester.get(buildUrl(gameId));
    const comments = Object.values(result);

    return comments;
}
export default {
    create,
    getAll,
}