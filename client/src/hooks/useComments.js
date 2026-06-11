import { useEffect, useReducer } from 'react';
import commentsAPI from '../api/comments-api'

export function useCreateComment() {
    const createHandler = (gameId, comments) => commentsAPI.create(gameId, comments)

    return createHandler;
}

function commentsReduser(state, action) {
    switch (action.type) {
        case 'GET_ALL':
            return action.payload.slice();
        case 'ADD_COMMENT':
            return [...state, action.payload];
        default:
            return state;
    }
}

export function useGetAllComments(gameId) {
    const [comments, dispatch] = useReducer(commentsReduser, []);

    useEffect(() => {
        (async () => {
            const result = await commentsAPI.getAll(gameId);
            dispatch({ type: 'GET_ALL', payload: result });
        })();
    }, [gameId]);

    return [comments, dispatch]
}