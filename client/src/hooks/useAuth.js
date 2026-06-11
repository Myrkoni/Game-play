
import { login, register, logout } from "../api/auth-api"
import { useAuthContext } from "../contexts/authContext"

export const useLogin = () => {

    const { changeAutState } = useAuthContext();

    const loginHandler = async (email, password) => {
        const { password: _, ...authData } = await login(email, password);
        changeAutState(authData);

        return authData
    };

    return loginHandler
}

export const useRegister = () => {
    const { changeAutState } = useAuthContext();

    const registerHandler = async (email, password) => {
        const { password: _, ...authData } = await register(email, password);
        changeAutState(authData);

        return authData
    };

    return registerHandler;
}

export const useLogout = () => {
    const { logout: localLogout } = useAuthContext();

    const logoutHandler = async () => {
        localLogout();
        await logout();
    };

    return logoutHandler;
}