
export const handler = async (event: any, context: any): Promise<any> => {

    console.log("Input event: ", JSON.stringify(event));

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: `Hello!`
        }),
    };
};