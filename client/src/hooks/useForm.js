import { useEffect, useState } from "react";

export function useForm(initialValues, submitCallBack) {
    const [values, setValues] = useState(initialValues);

    useEffect(() => {
        setValues(initialValues);
    }, [initialValues])

    const changeHandler = (e) => {
        setValues(state => ({
            ...state,
            [e.target.name]: e.target.value
        }))
    }

    const submitHandler = async (e) => {
        e.preventDefault();

        await submitCallBack(values);

        setValues(initialValues);
    };

    return {
        values,
        changeHandler,
        submitHandler,
        setValues,
    }

}